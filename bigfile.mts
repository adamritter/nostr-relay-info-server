// Big file handling
const fs = require("fs");

function writeEntry(fd: number, entry: any[]) {
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

function readBytes(fd: number, l: number) {
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

function writeBytes(fd: number, data: Buffer) {
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

function readEntry(fd: number) {
  const r: Buffer | undefined = readBytes(fd, 6);
  if (!r) {
    return undefined;
  }
  const rs = r.toString();
  if (rs?.[5] !== "|") {
    return undefined;
  }
  let length: number = Number.parseInt(rs.slice(0, 5), 36);
  const data: Buffer | undefined = readBytes(fd, length);
  if (!data) {
    throw new Error("Error reading " + length + "bytes");
  }
  const datas = data.toString();

  let last: string | undefined = readBytes(fd, 1)?.toString();
  if (last !== "\n") {
    throw new Error("Not newline at end of entry");
  }
  return JSON.parse(datas);
}

function writeEntriesToFile(path: string, entries: any[]) {
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

export function writeObjectToFile(path: string, obj: Object) {
  return writeEntriesToFile(path, Object.entries(obj));
}

export function writeMapToFile(path: string, map: Map) {
  return writeEntriesToFile(path, map.entries());
}

export function readObjectFromFile(path: string) {
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

export function readMapFromFile(path: string) {
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

export function readLines(
  filePath: string,
  lineCallback: (line: string) => void
): void {
  const bufferSize = 32000;
  const buffer = Buffer.alloc(bufferSize);
  let fileDescriptor;

  try {
    fileDescriptor = fs.openSync(filePath, "r");
    let line = "";
    let bytesRead;

    do {
      bytesRead = fs.readSync(fileDescriptor, buffer, 0, bufferSize, null);
      let currentBuffer = buffer.slice(0, bytesRead).toString();

      let newlineIndex = currentBuffer.indexOf("\n");
      while (newlineIndex > -1) {
        const chunk = currentBuffer.slice(0, newlineIndex);
        line += chunk;
        lineCallback(line);
        line = "";

        currentBuffer = currentBuffer.slice(newlineIndex + 1);
        newlineIndex = currentBuffer.indexOf("\n");
      }

      line += currentBuffer;
    } while (bytesRead === bufferSize);
  } catch (err) {
    console.error(`Error reading file: ${err}`);
  } finally {
    if (fileDescriptor) {
      fs.closeSync(fileDescriptor);
    }
  }
}
