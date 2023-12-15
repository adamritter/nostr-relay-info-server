import {open} from "lmdb";

export function dumpLMDB(path: string) {
  console.log("dumping", path);
  const env = open({
    path,
    maxDbs: 1,
  });
  const db = env.openDB({
    name: "default",
  });
  for (let {key, value} of db.getRange()) {
    console.log(key, value);
  }
  env.close();
}

dumpLMDB(process.argv[2]);
