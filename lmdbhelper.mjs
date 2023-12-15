import {open} from "lmdb";

/**
 * Opens an LMDB database from a file.
 *
 * @param {string} path - The path to the file.
 * @returns {lmdb.Database<any, lmdb.Key>} The opened LMDB database.
 */
export function openLMDBFromFile(path) {
 let env = open({
    path,
    maxDbs: 1,
  });
  return env.openDB({
    name: "default",
  });
}


/**
 * Opens an LMDB database from a file.
 *
 * @param {lmdb.Database<any, lmdb.Key> | Map<any, any>} db - The path to the file.
 */
export function getIterator(db) {
  if (db instanceof Map) {
    return db;
  } else {
    return db.getRange();
  }
}
