import {openLMDBFromFile} from "./lmdbhelper.mjs";

export function benchLMDB(path: string) {
  let keys = getAllKeys(process.argv[2]);
  // randomize keys
  keys = keys.sort(() => Math.random() - 0.5);

  console.log("benching", path);
  const db = openLMDBFromFile(path);

  const start = Date.now();
  // Get: 1us, parse: 8us
  let z = 0;
  for (let key of keys) {
    z += db.get(key)[0];
  }
  const end = Date.now();
  // log time per key in us
  console.log("time", (((end - start) * 1.0) / keys.length) * 1000, "us");
  console.log("z", z);
}

function getAllKeys(path: string) {
  const db = openLMDBFromFile(path);

  const start = Date.now();
  // Get: 1us, parse: 8us
  const keys = [];
  for (let {key, value: _} of db.getRange()) {
    keys.push(key);
  }
  const end = Date.now();
  console.log("time", end - start);
  return keys;
}

benchLMDB(process.argv[2]);
