const fs = require("fs");

function writeEntry(fd, entry) {
  let json = JSON.stringify(entry);
  let data = Buffer.from(json, "utf8");
  let l = data.length.toString(36);
  // Prefer big blocks, max 36MB by default
  while (l.length < 5) {
    l = "0" + l;
  }
  writeBytes(fd, Buffer.from(l + "|", "utf8"));
  writeBytes(fd, data);
  writeBytes(fd, Buffer.from("\n", "utf8"));
}

function readBytes(fd, l) {
  const r = Buffer.alloc(l);
  let pos = 0;
  while (pos < l) {
    let read = fs.readSync(fd, r, pos, l - pos);
    if (read === 0) {
      return undefined;
    }
    pos += read;
  }
  return r;
}

function writeBytes(fd, data) {
  let pos = 0;
  let l = data.length;
  while (pos < l) {
    let written = fs.writeSync(fd, data, pos, l - pos);
    if (written === 0) {
      throw new Error("Error writing " + l + "bytes");
    }
    pos += written;
  }
}

function readEntry(streamPos) {
  let r = readBytes(streamPos, 6);
  if (!r) {
    return undefined;
  }
  r = r.toString();
  if (r?.[5] !== "|") {
    return undefined;
  }
  let length = Number.parseInt(r.slice(0, 5), 36);
  let data = readBytes(streamPos, length);
  data = data.toString();
  if (!data) {
    throw new Error("Error reading " + length + "bytes");
  }
  let last = readBytes(streamPos, 1)?.toString();
  if (last !== "\n") {
    throw new Error("Not newline at end of entry");
  }
  return JSON.parse(data);
}

function writeEntriesToFile(path, entries) {
  console.log("Writing entries to " + path);
  const fd = fs.openSync(path, "w");
  let body = [];
  for (const entry of entries) {
    body.push(entry);
    if (body.length === 100) {
      writeEntry(fd, body);
      body = [];
    }
  }
  if (body.length > 0) {
    writeEntry(fd, body);
  }
  fs.closeSync(fd);
}

function writeObjectToFile(path, obj) {
  return writeEntriesToFile(path, Object.entries(obj));
}

function writeMapToFile(path, map) {
  return writeEntriesToFile(path, map.entries());
}

function readObjectFromFile(path) {
  let fd = fs.openSync(path, "r");
  let kv = readEntry(fd);
  let r = {};
  while (kv) {
    for (let kv2 of kv) {
      r[kv2[0]] = kv2[1];
    }
    kv = readEntry(fd);
  }
  return r;
}

function readMapFromFile(path) {
  let fd = fs.openSync(path, "r");
  let kv = readEntry(fd);
  let r = new Map();
  while (kv) {
    for (let kv2 of kv) {
      r.set(kv2[0], kv2[1]);
    }
    kv = readEntry(fd);
  }
  return r;
}

function testObject() {
  const contacts = JSON.parse(fs.readFileSync("contacts2.json"));
  writeObjectToFile("contactscopy.json", contacts);
  const contacts2 = readObjectFromFile("contactscopy.json");
  fs.writeFileSync("contactscopy2.json", JSON.stringify(contacts2));
}

function testMap() {
  const contacts = new Map(
    Object.entries(JSON.parse(fs.readFileSync("contacts2.json")))
  );
  writeMapToFile("contactscopy3.json", contacts);
  const contacts2 = readMapFromFile("contactscopy3.json");
  fs.writeFileSync(
    "contactscopy4.json",
    JSON.stringify(Object.fromEntries(contacts2.entries()))
  );
}

testObject();
testMap();
