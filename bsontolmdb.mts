// Convert bson to lmdb
// Usage: bsontolmdb.mts <bson file> <lmdb directory>
// import bigfile
import {readEntry} from "./bigfile.mjs";
import * as fs from "fs";

import {openLMDBFromFile} from "./lmdbhelper.mjs";

async function convert(bsonPath: string, lmdbPath: string) {
  const db = openLMDBFromFile(lmdbPath);

  let fd = fs.openSync(bsonPath, "r");
  let kv = readEntry(fd);
  while (kv) {
    for (let kv2 of kv) {
      db.put(kv2[0], kv2[1]);
    }
    kv = readEntry(fd);
  }

  await db.flushed;
}

convert(process.argv[2], process.argv[3]);
