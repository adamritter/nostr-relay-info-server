// Convert bson to lmdb
// Usage: bsontolmdb.mts <bson file> <lmdb directory>
// import bigfile
import {readEntry} from "./bigfile.mjs";
import * as lmdb from "lmdb";
import * as fs from "fs";

async function convert(bsonPath: string, lmdbPath: string) {
  // open lmdb
  const env = lmdb.open({
    path: lmdbPath,
    mapSize: 2 * 1024 * 1024 * 1024, // maximum database size
    maxDbs: 1,
  });
  const dbi = env.openDB({
    name: "default",
  });

  let fd = fs.openSync(bsonPath, "r");
  let kv = readEntry(fd);
  while (kv) {
    for (let kv2 of kv) {
      dbi.put(kv2[0], kv2[1]);
    }
    kv = readEntry(fd);
  }

  await dbi.flushed;
  await env.close();
}

convert(process.argv[2], process.argv[3]);
