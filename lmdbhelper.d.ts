declare module "./lmdbhelper.mjs";
import * as lmdb from "lmdb";
export function openLMDBFromFile(path: string): lmdb.Database<any, lmdb.Key>;
