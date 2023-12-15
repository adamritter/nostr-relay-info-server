// read into map
import {readMapFromFile} from "./bigfile.mjs";

function benchMap(map: Map<any, any>) {
  let keys = [];
  for (let [k, _] of map) {
    keys.push(k);
  }
  keys = keys.sort(() => Math.random() - 0.5);
  let z = 0;
  let start = Date.now();
  // 0.2us per key
  for (let k of keys) {
    z += map.get(k)[0];
  }
  let end = Date.now();
  console.log("time", (((end - start) * 1.0) / keys.length) * 1000, "us");

  console.log("z", z);
}

let map = readMapFromFile(process.argv[2]);
benchMap(map);
