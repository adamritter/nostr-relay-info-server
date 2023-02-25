const fs = require("fs");
const JSONStream = require("JSONStream");
const es = require("event-stream");

async function readObjectFromFile(path) {
  return new Promise((resolve, reject) => {
    let out = {};
    const readStream = fs.createReadStream(path);
    readStream
      .pipe(JSONStream.parse("$*"))
      .pipe(
        es.mapSync(function (data) {
          out[data.key] = data.value;
        })
      )
      .on("end", function () {
        resolve(out);
      });
  });
}

async function readMapFromFile(path) {
  const readStream = fs.createReadStream(path);
  return new Promise((resolve, reject) => {
    let out = new Map();

    readStream
      .pipe(JSONStream.parse("$*"))
      .pipe(
        es.mapSync(function (data) {
          out.set(data.key, data.value);
        })
      )
      .on("end", function () {
        resolve(out);
      });
  });
}

function writeObjectToFile(path, obj) {
  const stream = JSONStream.stringifyObject();
  const writeStream = fs.createWriteStream(path);
  stream.pipe(writeStream);
  for (const [key, value] of Object.entries(obj)) {
    stream.write([key, value]);
  }
  stream.end();
}

function writeMapToFile(path, obj) {
  const stream = JSONStream.stringifyObject();
  const writeStream = fs.createWriteStream(path);
  stream.pipe(writeStream);
  for (const [key, value] of obj.entries()) {
    stream.write([key, value]);
  }
  stream.end();
}

function getEntryToWrite(entry) {
  let data = JSON.stringify(entry);
  let l = data.length.toString(36);
  while (l.length < 4) {
    l = "0" + l;
  }
  return l + "|" + data + "\n";
}

function writeEntry(stream, entry) {
  stream.write(getEntryToWrite(entry));
}

async function readFromChunks(streamPos, l) {
  return new Promise((resolve, reject) => {
    streamPos[3].push([l, resolve, reject]);
  });
}

function processChunks(streamPos) {
  let [stream, pos, chunks, tasks] = streamPos;
  let chunk;
  while ((chunk = stream.read()) != null) {
    chunks.push(chunk);
  }
  let left = -pos;
  for (let chunk in chunks) {
    left += chunk.length;
  }
  console.log("left: ", left);
  while (tasks.length > 0 && left >= tasks[0][0]) {
    let [l, resolve, _] = tasks.shift();
    let r = new Uint8Array(l);
    let rpos = 0;
    while (rpos < l) {
      console.log(typeof chunks[0]);
      let chunk = chunks[0].subarray(pos, l - rpos);
      r.set(chunk, rpos);
      rpos += chunk.length;
      pos += chunk.length;
      if (pos === chunks[0].length) {
        chunks.shift();
        pos = 0;
      }
    }
    console.log("returning from readFromChunks", r.length);
    streamPos[1] = pos;
    resolve(Buffer.from(r));
  }
}

function readEntry(streamPos) {
  let r = readFromChunks(streamPos, 5)?.toString();
  console.log("read", r.length);
  if (r?.[4] !== "|") {
    return undefined;
  }
  let length = Number.parseInt(r.toString().slice(0, 4), 36);
  console.log("length", length);
  let data = readFromChunks(streamPos, length)?.toString();
  if (!data) {
    throw new Error("Error reading " + length + "bytes");
  }
  let last = readFromChunks(streamPos, 1)?.toString();
  if (last !== "\n") {
    return undefined;
  }
  return JSON.parse(data);
}

function writeObjectToFile2(path, obj) {
  const writeStream = fs.createWriteStream(path);
  for (const [key, value] of Object.entries(obj)) {
    writeEntry(writeStream, [key, value]);
  }
  writeStream.end();
}

function writeObjectToFile3(path, obj) {
  const writeStream = fs.createWriteStream(path);
  let es = Object.entries(obj);
  console.log("es", es.length);
  for (let i = 0; i < es.length; i += 100) {
    writeEntry(writeStream, es.splice(i, 100));
  }
  writeStream.end();
}

// const readable = getReadableStreamSomehow();

// // 'readable' may be triggered multiple times as data is buffered in
// readable.on('readable', () => {
//   let chunk;
//   console.log('Stream is readable (new data received in buffer)');
//   // Use a loop to make sure we read all currently available data
//   while (null !== (chunk = readable.read())) {
//     console.log(`Read ${chunk.length} bytes of data...`);
//   }
// });

// // 'end' will be triggered once when there is no more data available
// readable.on('end', () => {
//   console.log('Reached end of stream.');
// });
// class BlockReader {
//   constructor(stream) {
//     this.stream = stream;
//   }
// }

async function readStreamedObject(path) {
  const readStream = fs.createReadStream(path);
  readStream.on("readable", () => {
    let streamPos = [readStream, 0, []];
    let kv = readEntry(streamPos);
    let r = [];
    while (kv) {
      for (let kv2 in kv) {
        r[kv2[0]] = kv2[1];
      }
      kv = readEntry(streamPos);
    }
    readStream.close();
  });
  return new Promise((resolve) => {
    readStream.on("end", resolve);
  });
}

async function copyContactsOrig() {
  // Copy contacts
  const contacts = JSON.parse(fs.readFileSync("contacts2.json"));
  fs.writeFileSync("contactscopy.json", JSON.stringify(contacts));
}

async function copyContactsWriteFile() {
  // Copy contacts
  // const contacts = JSON.parse(fs.readFileSync("contacts2.json"));
  const contacts = await readObjectFromFile("contacts2.json");
  fs.writeFileSync("contactscopy.json", JSON.stringify(contacts));
}

async function copyContacts2() {
  // Copy contacts
  // const contacts = JSON.parse(fs.readFileSync("contacts2.json"));
  const contacts = await readObjectFromFile("contacts2.json");
  writeObjectToFile2("contactscopy.json", contacts);
}

async function copyContacts3() {
  // Copy contacts
  // const contacts = JSON.parse(fs.readFileSync("contacts2.json"));
  const contacts = await readObjectFromFile("contacts2.json");
  writeObjectToFile3("contactscopy.json", contacts);
}

async function copyContactsBack() {
  const contacts = await readStreamedObject("contactscopy.json");
  fs.writeFileSync("contactscopy2.json", JSON.stringify(contacts));
}

async function copyContactsMap() {
  // Copy contacts
  // const contacts = JSON.parse(fs.readFileSync("contacts2.json"));
  const contacts = await readMapFromFile("contacts2.json");
  writeMapToFile("contactscopy.json", contacts);
}
// copyContactsOrig();
// copyContacts2();
// copyContacts3();
copyContactsBack();
