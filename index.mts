// Speed testing in web browser:
// w=new WebSocket("wss://rbr.bio"); w.onopen=()=>console.log("opened"); w.onmessage=(x)=>console.log("message", x)
// z=0;all=1000;time=Date.now();w.onmessage=(x)=>{if(JSON.parse(x.data)[0]=="EVENT") z++; if(z==all) console.log("time",Date.now()-time) }; for(i=0;i<all;i++) w.send('["REQ","1",{"authors":["82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2"],"kinds":[0]}]')
// 2500ms
// let u="https://rbr.bio/82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2/metadata.json"
// time=Date.now(); a=[];for(i=0; i<1000; i++) a.push(fetch(u)); for(i=0; i<a.length; i++) await a[i]; console.log(Date.now()-time)
// 21035ms
// I guess the websocket is 10x faster than the http request
// time=Date.now();for(i=0; i<1000; i++) JSON.parse(data);Date.now()-time
// 2ms
// 3200ms with contacts as well??? strange
// TODO:
// ["COUNT", "", {kinds: [3], '#p': [<pubkey>]}]
// ["COUNT", "", {count: 238}]

import {IncomingMessage, ServerResponse} from "http";
import fetch from "node-fetch";
import {RelayPool} from "nostr-relaypool";
import {Event} from "nostr-relaypool/event";
import {matchFilters, nip19} from "nostr-tools";

const fs = require("fs");
const v8 = require("v8");

// Big file handling

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

function writeObjectToFile(path: string, obj: Object) {
  return writeEntriesToFile(path, Object.entries(obj));
}

function writeMapToFile(path: string, map: Map) {
  return writeEntriesToFile(path, map.entries());
}

function readObjectFromFile(path: string) {
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

function readMapFromFile(path: string) {
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

const oldestCreatedAtPerRelay = new Map<string, number>();
const newestCreatedAtPerRelay = new Map<string, number[]>();

const allWriteRelays: string[] = [];
const mainWriteRelays: string[] = [];

function addOrGetRelayIndex(relay: string) {
  let index = allWriteRelays.indexOf(relay);
  if (index === -1) {
    index = allWriteRelays.length;
    allWriteRelays.push(relay);
  }
  return index;
}
const lastCreatedAtAndRelayIndicesPerPubkey = new Map<
  string,
  [number, number[]]
>();

let lastCreatedAtAndMetadataPerPubkey = new Map<string, [number, string]>();
let lastCreatedAtAndContactsPerPubkey = new Map<string, [number, string]>();
const authors: [string, string, number][] = []; // [name, pubkey, followerCount]

const followers = new Map<string, string[]>();
let popularFollowers: string[] = [];

function computeAuthors() {
  const start = Date.now();
  for (let [pubkey, [_, metadata]] of lastCreatedAtAndMetadataPerPubkey) {
    try {
      let metadataInfos = JSON.parse(metadata);
      let content = JSON.parse(metadataInfos.content);
      if (content.name) {
        authors.push([
          content.name.toLowerCase(),
          pubkey,
          followers.get(pubkey)?.length || 0,
        ]);
      }
      if (content.display_name) {
        if (
          content.display_name.toLowerCase() !== content.name?.toLowerCase()
        ) {
          authors.push([
            content.display_name.toLowerCase(),
            pubkey,
            followers.get(pubkey)?.length || 0,
          ]);
        }
        // look for space
        let space = content.display_name.indexOf(" ");
        if (space !== -1) {
          authors.push([
            content.display_name.substr(space + 1).toLowerCase(),
            pubkey,
            followers.get(pubkey)?.length || 0,
          ]);
        }
      }
    } catch (e) {
      continue;
    }
  }
  authors.sort((a, b) => (b[0] < a[0] ? 1 : -1));
  console.log("computed authors in ", Date.now() - start, "ms");
}

function computeFollowers() {
  for (let [pubkey, [_, contacts]] of lastCreatedAtAndContactsPerPubkey) {
    pubkey = pubkey.toLowerCase();
    let contactInfos = JSON.parse(contacts);
    for (let contact of contactInfos.tags) {
      if (contact[0] === "p" && contact[1]) {
        let followed = contact[1].toLowerCase();
        let follower = followers.get(followed);
        if (follower === undefined) {
          follower = [];
          followers.set(followed, follower);
        }
        follower.push(pubkey);
      }
    }
  }
  for (let follower of followers.values()) {
    // Sort by follower count
    follower.sort((a, b) => {
      let aCount = followers.get(a)?.length || 0;
      let bCount = followers.get(b)?.length || 0;
      return bCount - aCount;
    });
  }

  popularFollowers = Array.from(followers.keys()).sort(
    (a, b) => followers.get(b)!.length - followers.get(a)!.length
  );
}

function saveData() {
  console.log("Saving data, ", v8.getHeapStatistics());
  let time = Date.now();
  const data = {
    oldestCreatedAtPerRelay: Object.fromEntries(oldestCreatedAtPerRelay),
    newestCreatedAtPerRelay: Object.fromEntries(newestCreatedAtPerRelay),
    allWriteRelays,
    mainWriteRelays,
    lastCreatedAtAndRelayIndicesPerPubkey: Object.fromEntries(
      lastCreatedAtAndRelayIndicesPerPubkey
    ),
  };
  const fs = require("fs");
  fs.writeFileSync("./data.json.new", JSON.stringify(data));
  // fs.writeFileSync(
  //   "./metadata.json.new",
  //   JSON.stringify(Object.fromEntries(lastCreatedAtAndMetadataPerPubkey))
  // );
  writeMapToFile("./metadata.bjson.new", lastCreatedAtAndMetadataPerPubkey);
  // fs.writeFileSync(
  //   "./contacts.json.new",
  //   JSON.stringify(Object.fromEntries(lastCreatedAtAndContactsPerPubkey))
  // );
  writeMapToFile("./contacts.bjson.new", lastCreatedAtAndContactsPerPubkey);
  renameIfNotSmallerSync("./data.json.new", "./data.json");
  renameIfNotSmallerSync("./metadata.bjson.new", "./metadata.bjson");
  renameIfNotSmallerSync("./contacts.bjson.new", "./contacts.bjson");
  console.log("saved data in ", Math.round((Date.now() - time) / 1000), "s");
}
function renameIfNotSmallerSync(from: string, to: string) {
  const fs = require("fs");
  if (!fs.existsSync(to)) {
    fs.renameSync(from, to);
    return;
  }
  if (!fs.existsSync(from)) {
    throw new Error("from does not exist " + from);
  }
  let fromSize = fs.statSync(from).size;
  let toSize = fs.statSync(to).size;
  if (fromSize >= toSize) {
    fs.renameSync(from, to);
  } else {
    throw new Error("new file is smaller " + from + " " + to);
  }
}

function onevent(event: Event, afterEose: boolean, url: string | undefined) {
  if (event.kind === 3) {
    oncontact(event, afterEose, url);
    onevent3(event, afterEose, url);
  } else if (event.kind === 0) {
    onevent0(event, afterEose, url);
  }
}
function onevent0(event: Event, afterEose: boolean, url: string | undefined) {
  let lastlast = lastCreatedAtAndMetadataPerPubkey.get(event.pubkey)?.[0];
  if (lastlast !== undefined && lastlast > event.created_at) {
    return;
  }
  // @ts-ignore
  event.relayPool = undefined;
  // @ts-ignore
  event.relays = undefined;
  lastCreatedAtAndMetadataPerPubkey.set(event.pubkey, [
    event.created_at,
    JSON.stringify(event),
  ]);
  if (lastCreatedAtAndMetadataPerPubkey.size % 100 === 0) {
    console.log("event0", lastCreatedAtAndMetadataPerPubkey.size);
  }
}

function oncontact(event: Event, afterEose: boolean, url: string | undefined) {
  let lastlast = lastCreatedAtAndContactsPerPubkey.get(event.pubkey)?.[0];
  if (lastlast !== undefined && lastlast > event.created_at) {
    return;
  }
  // @ts-ignore
  event.relayPool = undefined;
  // @ts-ignore
  event.relays = undefined;
  lastCreatedAtAndContactsPerPubkey.set(event.pubkey, [
    event.created_at,
    JSON.stringify(event),
  ]);
  if (lastCreatedAtAndContactsPerPubkey.size % 100 === 0) {
    console.log("event3 contacts", lastCreatedAtAndContactsPerPubkey.size);
  }
}
function onevent3(event: Event, afterEose: boolean, url: string | undefined) {
  let lastlast = lastCreatedAtAndRelayIndicesPerPubkey.get(event.pubkey)?.[0];
  if (lastlast !== undefined && lastlast > event.created_at) {
    return;
  }
  // @ts-ignore
  event.relayPool = undefined;
  // @ts-ignore
  event.relays = undefined;
  if (url) {
    let oldest = oldestCreatedAtPerRelay.get(url);
    if (oldest === undefined || oldest > event.created_at) {
      oldestCreatedAtPerRelay.set(url, event.created_at);
    }
    let newest = newestCreatedAtPerRelay.get(url);
    if (newest === undefined) {
      newest = [];
      newestCreatedAtPerRelay.set(url, newest);
    }
    newest.push(event.created_at);
    if (newest.length > 100) {
      newest.shift();
    }
  }
  let relayInfos;
  try {
    relayInfos = JSON.parse(event.content);
  } catch (e) {
    return;
  }
  if (relayInfos === undefined) {
    return;
  }
  let indices: number[] = [];
  for (let entry of Object.entries(relayInfos)) {
    // @ts-ignore
    if (entry[1].write) {
      let index = addOrGetRelayIndex(entry[0]);
      if (!indices.includes(index)) {
        indices.push(index);
      }
    }
  }
  lastCreatedAtAndRelayIndicesPerPubkey.set(event.pubkey, [
    event.created_at,
    indices,
  ]);

  if (lastCreatedAtAndRelayIndicesPerPubkey.size % 100 === 0) {
    console.log(lastCreatedAtAndRelayIndicesPerPubkey.size);
  }
}

function subscribe(
  relayPool: RelayPool,
  relays: string[],
  until?: number,
  since?: number
) {
  if (since && until && since > until) {
    return;
  }
  relayPool.subscribe(
    [{kinds: [0, 3], until, since}],
    relays,
    onevent,
    undefined,
    (url, minCreatedAt) => {
      console.log("EOSE", url, minCreatedAt);
      if (minCreatedAt < Infinity) {
        subscribe(relayPool, [url], minCreatedAt - 1);
      }
    },
    {unsubscribeOnEose: until !== undefined}
  );
}

async function getRelays() {
  let relaysBody = await fetch(
    "https://raw.githubusercontent.com/fiatjaf/nostr-relay-registry/master/relays.js"
  );
  let text = await relaysBody.text();
  let lines = text.split("\n");
  // @ts-ignore
  const relays: string[] = lines
    .map((line) => line.match(/(wss:.*)'/)?.[1])
    .filter((x) => x);
  console.log(relays);
  return relays;
}

function loadData(): boolean {
  let data, metadata, contacts;
  try {
    data = JSON.parse(fs.readFileSync("./data.json"));
    lastCreatedAtAndMetadataPerPubkey = readMapFromFile("./metadata.bjson");
    lastCreatedAtAndContactsPerPubkey = readMapFromFile("./contacts.bjson");
    // metadata = JSON.parse(fs.readFileSync("./metadata.json"));
    // lastCreatedAtAndMetadataPerPubkey.clear();
    // lastCreatedAtAndContactsPerPubkey.clear();
    // contacts = JSON.parse(fs.readFileSync("./contacts.json"));
    // for (let [k, v] of Object.entries(metadata)) {
    //   // @ts-ignore
    //   lastCreatedAtAndMetadataPerPubkey.set(k, v);
    // }
    // for (let [k, v] of Object.entries(contacts)) {
    //   // @ts-ignore
    //   lastCreatedAtAndContactsPerPubkey.set(k, v);
    // }
  } catch (err) {
    console.error("error loading data", err);
    return false;
  }
  console.log(
    "loaded base data, for 1cf35cc7507b8eaf6141d35473094a224a01cdc68264124523900de0441333fe",
    lastCreatedAtAndMetadataPerPubkey.get(
      "1cf35cc7507b8eaf6141d35473094a224a01cdc68264124523900de0441333fe"
    ),
    lastCreatedAtAndContactsPerPubkey.get(
      "1cf35cc7507b8eaf6141d35473094a224a01cdc68264124523900de0441333fe"
    )
  );

  oldestCreatedAtPerRelay.clear();
  newestCreatedAtPerRelay.clear();
  allWriteRelays.length = 0;
  mainWriteRelays.length = 0;
  lastCreatedAtAndRelayIndicesPerPubkey.clear();
  for (let [k, v] of Object.entries(data.oldestCreatedAtPerRelay)) {
    // @ts-ignore
    oldestCreatedAtPerRelay.set(k, v);
  }
  for (let [k, v] of Object.entries(data.newestCreatedAtPerRelay)) {
    // @ts-ignore
    newestCreatedAtPerRelay.set(k, v);
  }
  for (let relay of data.allWriteRelays) {
    allWriteRelays.push(relay);
  }
  for (let relay of data.mainWriteRelays) {
    mainWriteRelays.push(relay);
  }
  for (let [k, v] of Object.entries(
    data.lastCreatedAtAndRelayIndicesPerPubkey
  )) {
    // @ts-ignore
    lastCreatedAtAndRelayIndicesPerPubkey.set(k, v);
  }

  return true;
}

import {Filter} from "nostr-tools";
import WebSocket from "ws";

function writeJSONHeader(res: ServerResponse, errorCode: number) {
  res.writeHead(errorCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
}

const root = process.argv.includes("--root");
const relayInfoServerHost = process.argv.includes("--relay-info-server-host")
  ? process.argv[process.argv.indexOf("--relay-info-server-host") + 1]
  : "localhost";

const allowGlobalSubscriptions = process.argv.includes(
  "--allow-global-subscriptions"
);
const allowContinuingSubscriptions = process.argv.includes(
  "--allow-continuing-subscriptions"
);

function getWriteRelaysFromContactList(event: {content: string}) {
  let content;
  try {
    content = JSON.parse(event.content);
  } catch (err) {
    throw new Error(
      "error parsing content for pubkey " +
        event.pubkey +
        ": " +
        event.content +
        JSON.stringify(err)
    );
  }
  const r = [];
  for (let [k, v] of Object.entries(content)) {
    // @ts-ignore
    if (v.write) {
      r.push(k);
    }
  }
  return r;
}

function writeRelays(pubkey: string) {
  const contacts = lastCreatedAtAndContactsPerPubkey.get(pubkey);
  let contactList;
  try {
    if (contacts) {
      const contactjson = contacts[1];
      contactList = JSON.parse(contactjson);
    }
  } catch (err) {
    throw new Error(
      "error parsing contacts for " +
        pubkey +
        ": " +
        contacts?.[1] +
        JSON.stringify(err)
    );
  }
  return getWriteRelaysFromContactList(contactList);
}

export class RelayInfoServer {
  wss: WebSocket.Server;
  subs: Map<string, Filter[]> = new Map();
  connections: Set<WebSocket> = new Set();
  totalSubscriptions = 0;

  #emitEventForAuthor(
    ws: WebSocket.WebSocket,
    sub: string,
    author: string,
    filter: any
  ) {
    if (!filter.kinds || filter.kinds.includes(10003)) {
      const last = lastCreatedAtAndRelayIndicesPerPubkey.get(author);
      if (last) {
        let eventJSON = JSON.stringify([
          "EVENT",
          sub,
          {
            created_at: last[0],
            pubkey: author,
            content: JSON.stringify(last[1].map((i) => allWriteRelays[i])),
            kind: 10003,
          },
        ]);
        ws.send(eventJSON);
      }
    }
    if (!filter.kinds || filter.kinds.includes(0)) {
      const last = lastCreatedAtAndMetadataPerPubkey.get(author);
      if (last) {
        try {
          ws.send('["EVENT",' + JSON.stringify(sub) + "," + last[1] + "]");
        } catch (err) {}
      }
    }
    if (!filter.kinds || filter.kinds.includes(3)) {
      const last = lastCreatedAtAndContactsPerPubkey.get(author);
      if (last) {
        try {
          ws.send('["EVENT",' + JSON.stringify(sub) + "," + last[1] + "]");
        } catch (err) {}
      }
    }
  }
  constructor(
    server = undefined,
    port = root ? 81 : 8081,
    host = relayInfoServerHost
  ) {
    if (server) {
      this.wss = new WebSocket.Server({server, perMessageDeflate: true});
    } else {
      this.wss = new WebSocket.Server({port, host, perMessageDeflate: true});
      console.log("RelayInfoServer listening on ws://" + host + ":" + port);
    }
    this.wss.on("connection", (ws) => {
      this.connections.add(ws);
      ws.on("message", (message) => {
        const start = performance.now();
        let data;
        try {
          data = JSON.parse(message.toString());
        } catch (e) {
          ws.send(
            JSON.stringify(["NOTICE", "invalid json:", message.toString()])
          );
        }
        try {
          if (data && data[0] === "REQ") {
            const sub = data[1];
            const filters = data.slice(2);
            this.totalSubscriptions++;
            this.subs.set(sub, filters);
            for (const filter of filters) {
              if (filter.kinds && !Array.isArray(filter.kinds)) {
                continue;
              }
              if (
                Array.isArray(filter["#p"]) &&
                (!filter.kinds || filter.kinds.includes(3))
              ) {
                let limit = 200;
                if (filter.limit && filter.limit < 200) {
                  limit = filter.limit;
                }
                let count = 0;
                for (const author of filter["#p"]) {
                  for (const follower of followers.get(author) || []) {
                    if (count >= limit) {
                      break;
                    }
                    const contactList =
                      lastCreatedAtAndContactsPerPubkey.get(follower);
                    if (contactList && contactList[1]) {
                      try {
                        // const contacts = JSON.parse(contactList[1]);
                        // ws.send(JSON.stringify(["EVENT", sub, contacts]));
                        ws.send(
                          '["EVENT",' +
                            JSON.stringify(sub) +
                            "," +
                            contactList[1] +
                            "]"
                        );
                        count++;
                      } catch (err) {}
                    }
                  }
                }
              } else {
                if (
                  filter.kinds &&
                  !filter.kinds.includes(10003) &&
                  !filter.kinds.includes(0) &&
                  !filter.kinds.includes(3)
                ) {
                  continue;
                }
                if (filter.authors && Array.isArray(filter.authors)) {
                  for (const author of filter.authors) {
                    this.#emitEventForAuthor(ws, sub, author, filter);
                  }
                } else if (allowGlobalSubscriptions) {
                  const authors = new Set(
                    Array.from(
                      lastCreatedAtAndRelayIndicesPerPubkey.keys()
                    ).concat(
                      Array.from(
                        lastCreatedAtAndMetadataPerPubkey.keys()
                      ).concat(
                        Array.from(lastCreatedAtAndContactsPerPubkey.keys())
                      )
                    )
                  );
                  for (const author of authors) {
                    this.#emitEventForAuthor(ws, sub, author, filter);
                  }
                }
              }
            }
            ws.send(JSON.stringify(["EOSE", sub]));
          } else if (data && data[0] === "EVENT") {
            if (!allowContinuingSubscriptions) {
              return;
            }
            for (let [sub, filters] of this.subs.entries()) {
              if (matchFilters(filters, data[2])) {
                ws.send(JSON.stringify(["EVENT", sub, data[2]]));
              }
            }
          } else if (data && data[0] === "CLOSE") {
            const sub = data[1];
            this.subs.delete(sub);
          } else if (data && data[0] === "COUNT") {
            const sub = data[1];
            const filters = data.slice(2);
            const counts = [];
            for (const filter of filters) {
              if (
                filter &&
                Array.isArray(filter.kinds) &&
                filter.kinds.length === 1 &&
                filter.kinds[0] === 3 &&
                filter["#p"]
              ) {
                if (
                  Array.isArray(filter.group_by) &&
                  filter.group_by.length === 1 &&
                  filter.group_by[0] === "pubkey"
                ) {
                  if (filter["#p"].length === 1) {
                    const fs =
                      followers.get(filter["#p"][0])?.slice(0, 1000) || [];
                    counts.push(fs.map((f) => ({pubkey: f, count: 1})));
                  } else {
                    const byPubKey = new Map();
                    for (const pubkey of filter["#p"]) {
                      for (const follower of followers.get(pubkey) || []) {
                        byPubKey.set(
                          follower,
                          (byPubKey.get(follower) || 0) + 1
                        );
                      }
                    }
                    const r = [];
                    for (const [pubkey, count] of byPubKey.entries()) {
                      r.push({
                        pubkey,
                        count,
                        f: followers.get(pubkey)?.length || 0,
                      });
                    }
                    r.sort((a, b) => b.f - a.f);
                    for (const e of r) {
                      e.f = undefined;
                    }
                    counts.push(r);
                  }
                } else if (!filter.group_by) {
                  let count = 0;
                  for (const pubkey of filter["#p"]) {
                    count += followers.get(pubkey)?.length || 0;
                  }
                  counts.push({count});
                } else {
                  counts.push(null);
                }
              } else {
                counts.push(null);
              }
            }
            ws.send(JSON.stringify(["COUNT", sub, ...counts]));
          }
          stats.push([
            performance.now() - start,
            JSON.stringify(data),
            Date.now(),
          ]);
          if (stats.length > 1000) {
            stats.shift();
          }
        } catch (e) {
          ws.send(JSON.stringify(["NOTICE", "error: " + e]));
          errors.push([JSON.stringify(data), e]);
          if (errors.length > 100) {
            errors.shift();
          }
        }
      });
    });
  }
  async close(): Promise<void> {
    new Promise((resolve) => this.wss.close(resolve));
  }
  disconnectAll() {
    for (const ws of this.connections) {
      ws.close();
    }
  }
}

async function serveNew() {
  let relays = await getRelays();
  if (relays.length === 0) {
    console.error("error parsing relay file");
    process.exit(1);
  }

  for (let relay of relays) {
    if (!mainWriteRelays.includes(relay)) {
      mainWriteRelays.push(relay);
    }
  }
  // @ts-ignore
  const relayPool = new RelayPool(relays);

  for (let relay of relays) {
    subscribe(relayPool, [relay]);
  }
  setTimeout(saveData, 10 * 1000);
  setInterval(saveData, 60 * 1000);
  new RelayInfoServer();
}

async function continueServe() {
  if (!loadData()) {
    serveNew();
    return;
  }
  if (fs.existsSync("contacts.alsoload.bjson")) {
    console.log("Loading contacts.alsoload.bjson");
    const contacts: Map = readMapFromFile("contacts.alsoload.bjson");
    let i = 0,
      changed = 0,
      fresh = 0;
    for (const [pubkey, contact] of contacts.entries()) {
      i++;
      const current = lastCreatedAtAndContactsPerPubkey.get(pubkey);
      if (!current || contact[0] > current[0]) {
        if (current) changed++;
        else fresh++;
        lastCreatedAtAndContactsPerPubkey.set(pubkey, contact);
      }
    }
    console.log(
      "updated fresh: ",
      fresh,
      ", changed: ",
      changed,
      ", loaded (all): ",
      i
    );
  }
  let relays = await getRelays();

  for (let relay of relays) {
    if (!mainWriteRelays.includes(relay)) {
      mainWriteRelays.push(relay);
    }
  }
  // @ts-ignore
  const relayPool = new RelayPool(relays, {keepSignature: true, noCache: true});

  for (let relay of relays) {
    subscribe(relayPool, [relay], oldestCreatedAtPerRelay.get(relay));
    const newestCreatedAts = newestCreatedAtPerRelay.get(relay);
    subscribe(
      relayPool,
      [relay],
      undefined,
      newestCreatedAts?.[newestCreatedAts.length - 1]
    );
  }
  new RelayInfoServer();
  setTimeout(saveData, 10 * 1000);
  setInterval(saveData, 60 * 1000);
}

function getNameByPubKey(pubkey: string) {
  let v = lastCreatedAtAndMetadataPerPubkey.get(pubkey);
  if (!v) {
    return pubkey;
  }
  let md = JSON.parse(v[1]);
  let md2 = JSON.parse(md.content);
  let name = md2.display_name || md2.name || md2.nip05 || md.pubkey;
  return name;
}
function getPicture(pubkey: string) {
  let v = lastCreatedAtAndMetadataPerPubkey.get(pubkey);
  if (!v) {
    return;
  }
  try {
    let md = JSON.parse(v[1]);
    let md2 = JSON.parse(md.content);
    return md2.picture;
  } catch (e) {}
}

function npubEncode(pubkey: string) {
  try {
    return nip19.npubEncode(pubkey);
  } catch (e) {
    console.error("invalid pubkey ", pubkey + " called from npubEncode");
    throw new Error("invalid pubkey" + pubkey + e);
  }
}
function npubDecode(pubkey: string): string {
  try {
    // @ts-ignore
    return nip19.decode(pubkey).data;
  } catch (e) {
    console.error("invalid pubkey ", pubkey + " called from npubDecode");
    throw new Error("invalid pubkey" + pubkey + e);
  }
}

function profile(pubkey: string) {
  let body = [];
  let metadata = lastCreatedAtAndMetadataPerPubkey.get(pubkey);
  let mdnew, md2;
  if (metadata) {
    mdnew = JSON.parse(metadata[1]);
    md2 = JSON.parse(mdnew.content);
  }

  let name = md2?.display_name || md2?.name || md2?.nip05 || pubkey;

  let picture = md2?.picture;
  body.push('<span style="display: flex; justify-content: flex-start;">');
  if (picture) {
    body.push(
      `<a href='/${nip19.npubEncode(
        pubkey
      )}'><img src='${picture}' style='border-radius: 50%; cursor: pointer; max-height: min(30vw,60px); max-width: min(100%,60px);' width=60 height=60></a><br>`
    );
  } else {
    // just leave 60px
    body.push("<span style='width: 60px'></span>");
  }
  body.push("<span>");
  if (metadata) {
    body.push(`<a href='/${npubEncode(pubkey)}'>`);
    if (md2.display_name) {
      body.push(`<b style='font-size: 20px'>${md2.display_name}</b>`);
    }
    if (md2.name) {
      body.push(` @${md2.name}<br>`);
    }
    body.push("</a><br>");
    if (md2.nip05) {
      body.push(`<span style='color: #34ba7c'>${md2.nip05}</span><br>`);
    }
    if (md2.about) {
      body.push(`${md2.about}<br>`);
    }
  } else {
    body.push(`<a href='/${npubEncode(pubkey)}'>${name}</a><br><br>`);
  }

  body.push(
    `${followers.get(pubkey)?.length || 0}  followers<br></span></span>`
  );
  return body.join("");
}

function top() {
  return fs.readFileSync("top.html");
}

function app(
  req: IncomingMessage,
  res: ServerResponse,
  stats: any[],
  errors: [string, any][]
) {
  const start = performance.now();
  const original_url = req.url;
  if (req.url?.endsWith("/")) {
    req.url = req.url.slice(0, -1);
  }
  if (req.url?.startsWith("/npub") && req.url.length === 64) {
    let npub = req.url.slice(1);
    // Decode with nostr-tools
    let hex = nip19.decode(npub);
    req.url = "/" + hex.data;
  }
  if (req.url === "/favicon.ico") {
    res.writeHead(200, {"Content-Type": "image/x-icon"});
    res.end();
  } else if (req.url?.endsWith("/metadata.json")) {
    const pubkey = req.url.slice(1, -14);
    const metadata = lastCreatedAtAndMetadataPerPubkey.get(pubkey);
    if (metadata) {
      writeJSONHeader(res, 200);
      res.end(metadata[1]);
    } else {
      writeJSONHeader(res, 404);
      res.end(JSON.stringify({error: "metadata not found"}));
    }
  } else if (req.url?.endsWith("/contacts.json")) {
    const pubkey = req.url.slice(1, -14);
    const contacts = lastCreatedAtAndContactsPerPubkey.get(pubkey);
    if (contacts) {
      writeJSONHeader(res, 200);
      res.end(contacts[1]);
    } else {
      writeJSONHeader(res, 404);
      res.end(JSON.stringify({error: "contacts not found"}));
    }
  } else if (req.url?.endsWith("/writerelays.json")) {
    const pubkey = req.url.slice(1, -17);
    const contacts = lastCreatedAtAndContactsPerPubkey.get(pubkey);
    try {
      const relays = writeRelays(pubkey);
      if (contacts) {
        writeJSONHeader(res, 200);
        res.end(JSON.stringify(relays));
      } else {
        writeJSONHeader(res, 404);
        res.end(JSON.stringify({error: "writerelays not found"}));
      }
    } catch (e) {
      writeJSONHeader(res, 404);
      res.end(
        JSON.stringify({
          error: "error parsing write relays " + e,
        })
      );
    }
  } else if (req.url?.startsWith("/search/") && req.url?.endsWith(".json")) {
    const query = decodeURIComponent(req.url.slice(8, -5));
    if (query.length === 0) {
      writeJSONHeader(res, 200);
      res.end("[]");
    } else {
      // binary search in authors array first and last index that starts with query
      let first = 0;
      let last = authors.length - 1;
      let middle = Math.floor((first + last) / 2);
      while (first <= last) {
        if (authors[middle][0].startsWith(query)) {
          break;
        } else if (authors[middle][0] < query) {
          first = middle + 1;
        } else {
          last = middle - 1;
        }
        middle = Math.floor((first + last) / 2);
      }
      if (first > last) {
        writeJSONHeader(res, 200);
        res.end("[]");
      } else {
        let firstIndex = middle;
        while (firstIndex > 0 && authors[firstIndex - 1][0].startsWith(query)) {
          firstIndex--;
        }
        writeJSONHeader(res, 200);
        let r: any[] = [];
        let lowest = 0;
        while (authors[firstIndex][0]?.startsWith(query)) {
          if (
            authors[firstIndex][2] >= lowest &&
            !r.find((a) => a[1] === authors[firstIndex][1])
          ) {
            r.push(authors[firstIndex]);
            if (r.length > 5) {
              const id: string = r.find((a) => a[2] === lowest)?.[1];
              r = r.filter((a) => a[1] !== id);
              lowest = r.reduce((a, b) => (a[2] < b[2] ? a : b))[2];
            }
          }
          firstIndex++;
        }
        r.sort((a, b) => b[2] - a[2]);
        const r2 = [];
        for (let i = 0; i < r.length; i++) {
          const a = r[i];
          const md = lastCreatedAtAndMetadataPerPubkey.get(a[1]);
          if (md) {
            r2.push([a[2], JSON.parse(md[1]), npubEncode(a[1])]);
          }
        }
        res.end(JSON.stringify(r2));
      }
    }
  } else if (req.url?.startsWith("/") && req.url.length === 65) {
    const pubkey = req.url.slice(1);
    const metadata = lastCreatedAtAndMetadataPerPubkey.get(pubkey);
    const contacts = lastCreatedAtAndContactsPerPubkey.get(pubkey);
    let md = metadata && JSON.parse(metadata[1]);
    let md2 = md && JSON.parse(md.content);

    if (metadata || contacts) {
      res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});

      let body: string[] = [];
      let name = md2?.display_name || md2?.name || md2?.nip05 || pubkey;
      body.push(`<head><title>${name} | rbr.bio</title></head>`);
      body.push(top());
      if (md2?.banner) {
        body.push(
          `<img src="${md2.banner}" height="200" width="100%" style="object-fit: cover"/>`
        );
      }
      body.push(
        "<style>body {background-color: #121212; color: white;}</style>"
      );
      body.push("<style>a {color: #1d9bf0; text-decoration: none;}</style>");

      if (metadata) {
        body.push(
          '<div style="background-image: linear-gradient( to bottom, transparent, var(--main-color) ), url(https://cdn.jb55.com/s/voronoi3.gif);" />'
        );
        body.push('<span style="display: flex">');
        if (md2.picture) {
          body.push(
            "<img src='" +
              md2.picture +
              "' style='border-radius: 50%; cursor: pointer; max-height: min(30vw,200px); max-width: min(100%,200px);'><br>"
          );
        }
        body.push("<div style='margin-left: 1em'>");
        if (md2.display_name) {
          body.push("<b style='font-size: 20px'>" + md2.display_name + "</b>");
        }
        if (md2.name) {
          body.push(" @" + md2.name);
        }
        body.push("<br><br>");
        if (md2.nip05) {
          body.push(
            "<span style='color: #34ba7c'>" + md2.nip05 + "</span><br><br>"
          );
        }
        if (md2.about) {
          body.push(md2.about + "<br><br>");
        }
        if (md2.website) {
          body.push(
            "<a href='" +
              md2.website +
              "' target='_blank'>" +
              md2.website +
              "</a><br><br>"
          );
        }
        for (let k in md2) {
          if (
            k === "picture" ||
            k === "about" ||
            k === "website" ||
            k === "nip05" ||
            k === "name" ||
            k === "display_name" ||
            k === "banner"
          )
            continue;
          body.push(k + ": " + md2[k] + "<br>");
        }
        body.push("</div></span>");
        body.push(
          "<a href='/" + pubkey + "/metadata.json'>Metadata JSON</a> <br>"
        );
      }
      body.push("<br>Hex pubkey: " + pubkey + "<br>");
      body.push("Npub: " + npubEncode(pubkey) + "<br><br>");
      body.push(
        "<a href='/" +
          npubEncode(pubkey) +
          "/followers'>" +
          followers.get(pubkey)?.length +
          " followers (link)</a><br>"
      );

      body.push(
        " <a href='/" + pubkey + "/followers.json'>Followers JSON</a> <br><br>"
      );

      body.push(
        " <br><a href='/" + pubkey + "/info.json'>Info JSON</a> <br><br>"
      );

      if (contacts) {
        body.push(
          "<a href='/" + pubkey + "/contacts.json'>Contacts JSON</a> <br>"
        );

        let md = JSON.parse(contacts[1]);

        try {
          let md2 = JSON.parse(md.content);
          body.push(
            "<table><tr><th>Relay</th><th>Write</th><th>Read</th></tr>"
          );
          for (let [k, v] of Object.entries(md2)) {
            body.push("<tr><td>");
            body.push(k);
            body.push("</td><td>");
            body.push(v?.write);
            body.push("</td><td>");
            body.push(v?.read);
            body.push("</td></tr>");
          }
          body.push("</table>");
          body.push(
            "<a href='/" +
              pubkey +
              "/writerelays.json'>Write relays JSON</a> <br>"
          );
        } catch (e) {}
        body.push("<br><h1>Following:</h1> <br><br>");
        // horizontal breakable flex
        body.push(
          '<span style="display: flex;  flex-direction: column; justify-content: space-between; gap: 15px ">'
        );
        for (let tag of md.tags
          .slice()
          .sort(
            (a: string[], b: string[]) =>
              (followers.get(b[1]?.toLocaleLowerCase())?.length || 0) -
              (followers.get(a[1]?.toLocaleLowerCase())?.length || 0)
          )) {
          let pubkey = tag[1]?.toLowerCase();
          body.push(profile(pubkey));
        }
      }
      res.write(body.join(""));
      res.end();
    } else {
      res.writeHead(404, {"Content-Type": "text/html"});
      res.write(top());
      res.end("not found");
    }
  } else if (req.url?.endsWith("/info.json")) {
    // Return metadata and contacts for a user, and metadata and write relays for its contacts
    const pubkey = req.url.slice(1, -10);
    const metadataJSON = lastCreatedAtAndMetadataPerPubkey.get(pubkey)?.[1];
    const contactsJSON = lastCreatedAtAndContactsPerPubkey.get(pubkey)?.[1];

    if (metadataJSON || contactsJSON) {
      // json content with utf-8i
      writeJSONHeader(res, 200);
      let contacts, metadata;
      try {
        contacts = JSON.parse(contactsJSON);
      } catch (e) {}
      try {
        metadata = JSON.parse(metadataJSON);
      } catch (e) {}
      let r = {
        metadata,
        contacts,
      };
      // @ts-ignore
      r.followerCount = followers.get(pubkey)?.length;
      if (contacts) {
        // @ts-ignore
        r.following = [];
        for (let tag of contacts.tags
          .slice()
          .sort(
            (a: string[], b: string[]) =>
              (followers.get(b[1]?.toLocaleLowerCase())?.length || 0) -
              (followers.get(a[1]?.toLocaleLowerCase())?.length || 0)
          )) {
          let pubkey = tag[1]?.toLowerCase();
          let rr = {pubkey};
          try {
            const metadataJSON =
              lastCreatedAtAndMetadataPerPubkey.get(pubkey)?.[1];
            if (metadataJSON) {
              const metadata = JSON.parse(metadataJSON);
              const content = JSON.parse(metadata.content);
              // @ts-ignore
              rr.metadata = {
                name: content.name,
                display_name: content.display_name,
                picture: content.picture,
                about: content.about,
                nip05: content.nip05,
                followerCount: followers.get(pubkey)?.length,
              };
            }
          } catch (e) {}
          try {
            // @ts-ignore
            rr.writeRelays = writeRelays(pubkey);
          } catch (e) {}
          // @ts-ignore
          r.following.push(rr);
        }
      }
      res.write(JSON.stringify(r));
      res.end();
    } else {
      res.writeHead(404, {"Content-Type": "text/html"});
      res.write(top());
      res.end("not found");
    }
  } else if (req.url?.match("followers(/([0-9]+))?$")) {
    let page = parseInt(req.url?.match("followers(/([0-9]+))?$")[2] || "1");
    let pubkey = req.url.split("/")[1];
    if (pubkey.startsWith("npub")) {
      pubkey = npubDecode(pubkey);
    }
    let myfollowers = followers.get(pubkey);
    res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
    res.write(top());
    res.write("<h1>Followers</h1>");
    const body = [];
    body.push(
      '<span style="display: flex;  flex-direction: column; justify-content: space-between; gap: 15px ">'
    );
    for (let pubkey2 of myfollowers?.slice((page - 1) * 100, page * 100) ||
      []) {
      body.push(profile(pubkey2));
    }
    body.push("</span>");
    body.push("<br>");
    if (page > 1) {
      body.push(
        "<a href='/" +
          pubkey +
          "/followers/" +
          (page - 1) +
          "'>Previous page</a> "
      );
    }
    if (myfollowers?.length || 0 > page * 100) {
      body.push(
        "<a href='/" + pubkey + "/followers/" + (page + 1) + "'>Next page</a>"
      );
    }
    res.write(body.join(""));
    res.end();
    // followers.json
  } else if (req.url?.endsWith("/followers.json")) {
    let pubkey = req.url.split("/")[1];
    if (pubkey.startsWith("npub")) {
      pubkey = npubDecode(pubkey);
    }
    let myfollowers = followers.get(pubkey);
    writeJSONHeader(res, 200);
    res.write(JSON.stringify(myfollowers));
    res.end();
  } else if (req.url === "/stats") {
    res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
    res.write(`<head><title>Stats | rbr.bio</title></head>`);
    res.write(top());
    res.write("<h1>Stats</h1>");
    if (stats.length > 1) {
      let rps = stats.length / ((Date.now() - stats[0][2]) / 1000);
      res.write("<br>Requests per second: " + rps.toFixed(2));
      // Max possible requests per second: time passed divided by average time per request
      let maxRps =
        stats.length / (stats.reduce((a, b) => a + b[0], 0) / 1000.0);
      res.write(
        "<br>Max possible requests per second: " +
          Math.round(maxRps) +
          "<br><br>"
      );
    }
    res.write("<table><tr><th>ms</th><th>URL</th><th>Date</th></tr>");
    for (let i = 0; i < stats.length; i++) {
      res.write(
        "<tr><td>" +
          stats[i][0].toFixed(1) +
          "</td><td>" +
          stats[i][1] +
          "</td><td>" +
          stats[i][2] +
          "</td></tr>"
      );
    }
    res.write("</table>");

    if (errors.length > 0) {
      res.write("Errors:<br><table><tr><th>URL</th><th>Error</th></tr>");
      for (let i = 0; i < errors.length; i++) {
        res.write(
          "<tr><td>" + errors[i][0] + "</td><td>" + errors[i][1] + "</td></tr>"
        );
      }
      res.write("</table>");
    }

    res.end();
  } else if (req.url === "" || req.url === "/") {
    res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
    let body = [];
    body.push(`<head><title>rbr.bio</title></head>`);
    body.push("<style>body {background-color: #121212; color: white;}</style>");
    body.push("<style>a {color: #1d9bf0; text-decoration: none;}</style>");
    body.push(top());
    body.push(
      `<p>rbr.bio is a cache for all metadata and contacts served from RAM. It contains ${lastCreatedAtAndMetadataPerPubkey.size} metadata (probably half of it is fake, TODO: fix) and ${lastCreatedAtAndContactsPerPubkey.size} contacts. Content can be accessed by HTML, JSON and a relay (wss://rbr.bio). Contribute at <a target="_blank" href="https://github.com/adamritter/nostr-relay-info-server">https://github.com/adamritter/nostr-relay-info-server</a></p>
      <p>If you plan to integrate this service into your client (which I recommend), please use JSON queries instead of the relay API (as they will be cached in the future), and contact me on Nostr (or find me in person at Nostrica):</p>
      `
    );
    body.push(
      profile(
        "6e3f51664e19e082df5217fd4492bb96907405a0b27028671dd7f297b688608c"
      )
    );

    body.push(`<p><a href="/stats">Serving stats</a></p>`);
    for (let i = 0; i < 100; i++) {
      let k = popularFollowers[i];
      body.push(profile(k));
    }
    res.write(body.join(""));
    res.end();
  } else {
    res.writeHead(404, {"Content-Type": "text/html"});
    res.end("not found url " + JSON.stringify(req.url));
  }
  stats.push([performance.now() - start, original_url, Date.now()]);
  if (stats.length > 1000) {
    stats.shift();
  }
}

import {createServer} from "http";
let stats: any[] = [];
let errors: any[] = [];

function httpServe() {
  let server = createServer(function (req, res) {
    const original_url = req.url;
    try {
      app(req, res, stats, errors);
    } catch (e) {
      console.error("Error serving ", original_url, ":\n", e);
      errors.push([req.url, e]);
      if (errors.length > 100) {
        errors.shift();
      }
      if (!res.writableEnded) {
        res.end("<pre>Error serving " + original_url + ":\n" + e + "</pre>");
      }
    }
  });
  let port = root ? 80 : 8080;
  server.listen(port);
  console.log("http server listening on port " + port);
  return server;
}

function printFollowersWithoutMetadataStatistic() {
  let ii = 0,
    jj = 0,
    kk = 0,
    ll = 0;
  for (let [k, v] of followers.entries()) {
    if (v.size > 100 && !lastCreatedAtAndMetadataPerPubkey.get(k)) {
      ii++;
    }
    if (v.size > 10 && !lastCreatedAtAndMetadataPerPubkey.get(k)) {
      jj++;
    }
    if (v.size > 1 && !lastCreatedAtAndMetadataPerPubkey.get(k)) {
      kk++;
    }
    if (v.size > 0 && !lastCreatedAtAndMetadataPerPubkey.get(k)) {
      ll++;
    }
  }
  console.log(ii, "with more than 100 followers but no metadata");
  console.log(jj, "with more than 10 followers but no metadata");
  console.log(kk, "with more than 1 followers but no metadata");
  console.log(ll, "with more than 0 followers but no metadata");
}

function getFollowedWithoutMetadata() {
  let r = [];
  for (let [k, v] of followers.entries()) {
    if (v.length > 0 && !lastCreatedAtAndMetadataPerPubkey.get(k)) {
      r.push(k);
    }
  }
  r.sort(
    (a, b) => (followers.get(b)?.length || 0) - (followers.get(a)?.length || 0)
  );
  return r;
}

async function updateMetadataForPopularAuthors() {
  let followedWithoutMetadata = getFollowedWithoutMetadata();
  let relays = await getRelays();
  if (relays.length === 0) {
    console.error("error parsing relay file");
    process.exit(1);
  }
  const fs = require("fs");
  let relays2 = JSON.parse(fs.readFileSync("relays.json"));
  relays = [...new Set(relays.concat(relays2))];
  mainWriteRelays.length = 0;
  for (let relay of relays) {
    if (!mainWriteRelays.includes(relay)) {
      mainWriteRelays.push(relay);
    }
  }
  // @ts-ignore
  const relayPool = new RelayPool(relays);
  relayPool.onnotice = (notice: any) => {
    console.log("notice", notice);
  };
  relayPool.onerror = (error: any) => {
    console.log("error", error);
  };
  let step = 100,
    maxQueries = 2;
  for (
    let i = 0;
    i < followedWithoutMetadata.length && i < maxQueries * step;
    i += step
  ) {
    let batch = followedWithoutMetadata.slice(i, i + step);
    relayPool.subscribe([{kinds: [0], authors: batch}], relays, onevent0);
  }
  setTimeout(saveData, 10 * 1000);
  setInterval(saveData, 60 * 1000);
}

const updateData = process.argv.includes("--update-data");
const updateMetadata = process.argv.includes("--update-metadata");

if (updateData) {
  continueServe();
} else if (updateMetadata) {
  loadData();
  computeFollowers();
  computeAuthors();
  printFollowersWithoutMetadataStatistic();
  console.log(lastCreatedAtAndMetadataPerPubkey.size);
  updateMetadataForPopularAuthors();
  let server = httpServe();
  new RelayInfoServer(server);
} else {
  loadData();
  computeFollowers();
  computeAuthors();
  printFollowersWithoutMetadataStatistic();
  console.log(lastCreatedAtAndMetadataPerPubkey.size);
  let server = httpServe();
  new RelayInfoServer(server);
}
