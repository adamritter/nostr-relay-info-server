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

async function copyContacts() {
  // Copy contacts
  // const contacts = JSON.parse(fs.readFileSync("contacts2.json"));
  const contacts = await readObjectFromFile("contacts2.json");
  writeObjectToFile("contactscopy.json", contacts);
}

async function copyContactsMap() {
  // Copy contacts
  // const contacts = JSON.parse(fs.readFileSync("contacts2.json"));
  const contacts = await readMapFromFile("contacts2.json");
  writeMapToFile("contactscopy.json", contacts);
}
// copyContactsOrig();
copyContactsWriteFile(); // correct
// copyContacts(); // not correct :(
