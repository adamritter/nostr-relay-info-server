import fetch from "node-fetch";
import {RelayPool} from "nostr-relaypool";
import {Event} from "nostr-relaypool/event";

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

function saveData() {
  let time = new Date().getTime();
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
  fs.writeFileSync("./data.json", JSON.stringify(data));
  console.log(
    "saved data in ",
    Math.round((new Date().getTime() - time) / 1000),
    "s"
  );
}

function minCreatedAt(events: Event[]): number {
  let min_created_at = events[0].created_at;
  for (let event of events) {
    if (event.created_at < min_created_at) {
      min_created_at = event.created_at;
    }
  }
  return min_created_at;
}

function onevent(event: Event, afterEose: boolean, url: string | undefined) {
  if (event.kind !== 3) return;
  let lastlast = lastCreatedAtAndRelayIndicesPerPubkey.get(event.pubkey)?.[0];
  if (lastlast !== undefined && lastlast > event.created_at) {
    return;
  }
  // @ts-ignore
  event.relayPool = undefined;
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
    [{kinds: [3], until, since}],
    relays,
    onevent,
    undefined,
    (eventsByThisSub, url) => {
      console.log("EOSE", eventsByThisSub?.length, url);
      if (eventsByThisSub && eventsByThisSub?.length > 0) {
        // @ts-ignore
        subscribe(relayPool, [url], minCreatedAt(eventsByThisSub) - 1);
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
  let data;
  try {
    const fs = require("fs");
    data = JSON.parse(fs.readFileSync("./data.json"));
  } catch (err) {
    return false;
  }

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

export class RelayInfoServer {
  wss: WebSocket.Server;
  subs: Map<string, Filter[]> = new Map();
  connections: Set<WebSocket> = new Set();
  totalSubscriptions = 0;
  constructor(port = 8081, host = "localhost") {
    this.wss = new WebSocket.Server({port, host});
    this.wss.on("connection", (ws) => {
      this.connections.add(ws);
      // console.log('connected')
      ws.on("message", (message) => {
        let data;
        try {
          data = JSON.parse(message.toString());
        } catch (e) {
          ws.send(
            JSON.stringify(["NOTICE", "invalid json:", message.toString()])
          );
        }

        if (data && data[0] === "REQ") {
          const sub = data[1];
          const filters = data.slice(2);
          this.totalSubscriptions++;
          this.subs.set(sub, filters);
          console.log("sub", sub, filters);
          for (const filter of filters) {
            if (filter.kinds && !Array.isArray(filter.kinds)) {
              continue;
            }
            if (filter.kinds && !filter.kinds.includes(10003)) {
              continue;
            }
            if (filter.authors && Array.isArray(filter.authors)) {
              console.log("filtering by authors", filter.authors);
              for (const author of filter.authors) {
                const last = lastCreatedAtAndRelayIndicesPerPubkey.get(author);
                if (last) {
                  let eventJSON = JSON.stringify([
                    "EVENT",
                    sub,
                    {
                      created_at: last[0],
                      pubkey: author,
                      content: JSON.stringify(
                        last[1].map((i) => allWriteRelays[i])
                      ),
                      kind: 10003,
                    },
                  ]);
                  console.log("Sending: ", eventJSON);
                  ws.send(eventJSON);
                }
              }
            }
          }
          ws.send(JSON.stringify(["EOSE", sub]));
        } else if (data && data[0] === "EVENT") {
        } else if (data && data[0] === "CLOSE") {
          const sub = data[1];
          this.subs.delete(sub);
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
  const relayPool = new RelayPool(relays, {keepSignature: true, noCache: true});

  for (let relay of relays) {
    subscribe(relayPool, [relay]);
  }
  setInterval(saveData, 10 * 1000);
  new RelayInfoServer();
}

async function _serveOld() {
  loadData();
  new RelayInfoServer();
}

async function continueServe() {
  if (!loadData()) {
    serveNew();
    return;
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
  setInterval(saveData, 10 * 1000);
  new RelayInfoServer();
}

continueServe();
