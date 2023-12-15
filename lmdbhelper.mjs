import {open} from "lmdb";

/**
 * Opens an LMDB database from a file.
 *
 * @param {string} path - The path to the file.
 * @returns {lmdb.Database} The opened LMDB database.
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
