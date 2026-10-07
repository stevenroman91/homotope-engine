/**
 * T34 — Archive ZIP minimale, SANS dépendance : entrées « stockées » (méthode 0, aucune
 * compression), noms UTF-8 (drapeau 11), date fixe (1er janvier 1980 : deux exports du même
 * résultat donnent le même fichier). Sert aux séparations (un fichier par couleur), quelques
 * dizaines de fichiers de texte au plus : la compression n'en vaut pas le code. Pas de ZIP64
 * (plafonds : 65 535 entrées, 4 Gio), largement au-dessus de 64 couleurs. Pur, sans DOM.
 */

export const ZIP_MIME = 'application/zip';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Table du CRC-32 (polynôme 0xEDB88320, celui du ZIP). */
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Date DOS du 1er janvier 1980 (jour 1, mois 1, année 0), heure 00:00:00. */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;
const UTF8_FLAG = 1 << 11;

/** Écrit l'archive (noms uniques attendus ; un doublon est refusé). */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const seen = new Set<string>();
  const items = entries.map((e) => {
    if (seen.has(e.name)) throw new Error(`ZIP : nom en double « ${e.name} »`);
    seen.add(e.name);
    return { name: enc.encode(e.name), data: e.data, crc: crc32(e.data) };
  });
  let size = 22;
  for (const it of items) size += 30 + 46 + 2 * it.name.length + it.data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let p = 0;
  const u16 = (v: number) => {
    view.setUint16(p, v, true);
    p += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(p, v >>> 0, true);
    p += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, p);
    p += b.length;
  };
  const offsets: number[] = [];
  for (const it of items) {
    offsets.push(p);
    u32(0x04034b50);
    u16(20); // version requise : 2.0
    u16(UTF8_FLAG);
    u16(0); // stockée
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(it.crc);
    u32(it.data.length);
    u32(it.data.length);
    u16(it.name.length);
    u16(0);
    bytes(it.name);
    bytes(it.data);
  }
  const central = p;
  items.forEach((it, i) => {
    u32(0x02014b50);
    u16(20); // créé par : 2.0
    u16(20);
    u16(UTF8_FLAG);
    u16(0);
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(it.crc);
    u32(it.data.length);
    u32(it.data.length);
    u16(it.name.length);
    u16(0); // champ extra
    u16(0); // commentaire
    u16(0); // disque
    u16(0); // attributs internes
    u32(0); // attributs externes
    u32(offsets[i]!);
    bytes(it.name);
  });
  const centralSize = p - central;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(items.length);
  u16(items.length);
  u32(centralSize);
  u32(central);
  u16(0);
  return out;
}
