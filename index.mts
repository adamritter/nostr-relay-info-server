import fetch from "node-fetch";
import {RelayPool} from "nostr-relaypool";
import {Event} from "nostr-relaypool/event";
import {nip19} from "nostr-tools";

// Target speed: 40MB/sec

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

const lastCreatedAtAndMetadataPerPubkey = new Map<string, [number, string]>();
const lastCreatedAtAndContactsPerPubkey = new Map<string, [number, string]>();

const followers = new Map<string, Set<string>>();
let popularFollowers: string[] = [];

function computeFollowers() {
  for (let [pubkey, [_, contacts]] of lastCreatedAtAndContactsPerPubkey) {
    pubkey = pubkey.toLowerCase();
    let contactInfos = JSON.parse(contacts);
    for (let contact of contactInfos.tags) {
      if (contact[0] === "p" && contact[1]) {
        let followed = contact[1].toLowerCase();
        let follower = followers.get(followed);
        if (follower === undefined) {
          follower = new Set();
          followers.set(followed, follower);
        }
        follower.add(pubkey);
      }
    }
  }
  popularFollowers = Array.from(followers.keys()).sort(
    (a, b) => followers.get(b)!.size - followers.get(a)!.size
  );
}

function saveData() {
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
  fs.writeFileSync(
    "./metadata.json.new",
    JSON.stringify(Object.fromEntries(lastCreatedAtAndMetadataPerPubkey))
  );
  fs.writeFileSync(
    "./contacts.json.new",
    JSON.stringify(Object.fromEntries(lastCreatedAtAndContactsPerPubkey))
  );
  fs.renameSync("./data.json.new", "./data.json");
  fs.renameSync("./metadata.json.new", "./metadata.json");
  fs.renameSync("./contacts.json.new", "./contacts.json");
  console.log("saved data in ", Math.round((Date.now() - time) / 1000), "s");
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
    const fs = require("fs");
    data = JSON.parse(fs.readFileSync("./data.json"));
    metadata = JSON.parse(fs.readFileSync("./metadata.json"));
    contacts = JSON.parse(fs.readFileSync("./contacts.json"));
  } catch (err) {
    return false;
  }

  oldestCreatedAtPerRelay.clear();
  newestCreatedAtPerRelay.clear();
  allWriteRelays.length = 0;
  mainWriteRelays.length = 0;
  lastCreatedAtAndRelayIndicesPerPubkey.clear();
  lastCreatedAtAndMetadataPerPubkey.clear();
  lastCreatedAtAndContactsPerPubkey.clear();
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
  for (let [k, v] of Object.entries(metadata)) {
    // @ts-ignore
    lastCreatedAtAndMetadataPerPubkey.set(k, v);
  }
  for (let [k, v] of Object.entries(contacts)) {
    // @ts-ignore
    lastCreatedAtAndContactsPerPubkey.set(k, v);
  }
  return true;
}

import {Filter} from "nostr-tools";
import WebSocket from "ws";

const root = process.argv.includes("--root");

export class RelayInfoServer {
  wss: WebSocket.Server;
  subs: Map<string, Filter[]> = new Map();
  connections: Set<WebSocket> = new Set();
  totalSubscriptions = 0;
  constructor(port = root ? 81 : 8081, host = "0.0.0.0") {
    this.wss = new WebSocket.Server({port, host});
    this.wss.on("connection", (ws) => {
      this.connections.add(ws);
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
                for (const kind of filter.kinds) {
                  if (kind === 10003) {
                    const last =
                      lastCreatedAtAndRelayIndicesPerPubkey.get(author);
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
                  } else if (kind === 0) {
                    const last = lastCreatedAtAndMetadataPerPubkey.get(author);
                    if (last) {
                      let eventJSON = JSON.stringify(["EVENT", sub, last[1]]);
                      console.log("Sending: ", eventJSON);
                      ws.send(eventJSON);
                    }
                  } else if (kind === 3) {
                    const last = lastCreatedAtAndContactsPerPubkey.get(author);
                    if (last) {
                      let eventJSON = JSON.stringify(["EVENT", sub, last[1]]);
                      console.log("Sending: ", eventJSON);
                      ws.send(eventJSON);
                    }
                  }
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
      )}'><img src='${picture}' style='border-radius: 50%; cursor: pointer; max-height: min(30vw,60px); max-width: min(100%,60px);'></a><br>`
    );
  } else {
    // just leave 60px
    body.push("<span style='width: 60px'></span>");
  }
  body.push("<span>");
  if (metadata) {
    body.push(`<a href='/${nip19.npubEncode(pubkey)}'>`);
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
    body.push(`<a href='/${nip19.npubEncode(pubkey)}'>${name}</a><br><br>`);
  }

  body.push(`${followers.get(pubkey)?.size || 0}  followers<br></span></span>`);
  return body.join("");
}

function httpServe() {
  let stats: any[] = [];
  let http = require("http");
  http
    .createServer(function (req, res) {
      let start = Date.now();
      if (req.url?.endsWith("/")) {
        req.url = req.url.slice(0, -1);
      }
      if (req.url?.startsWith("/npub")) {
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
          res.writeHead(200, {"Content-Type": "application/json"});
          res.end(metadata[1]);
        } else {
          res.writeHead(404, {"Content-Type": "application/json"});
          res.end({error: "metadata not found"});
        }
      } else if (req.url?.endsWith("/contacts.json")) {
        const pubkey = req.url.slice(1, -14);
        const contacts = lastCreatedAtAndContactsPerPubkey.get(pubkey);
        if (contacts) {
          res.writeHead(200, {"Content-Type": "application/json"});
          res.end(contacts[1]);
        } else {
          res.writeHead(404, {"Content-Type": "application/json"});
          res.end({error: "contacts not found"});
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
          if (md2?.banner) {
            body.push(
              `<img src="${md2.banner}" height="200" width="100%" style="object-fit: cover"/>`
            );
          }
          body.push(
            "<style>body {background-color: #121212; color: white;}</style>"
          );
          body.push(
            "<style>a {color: #1d9bf0; text-decoration: none;}</style>"
          );

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
              body.push(
                "<b style='font-size: 20px'>" + md2.display_name + "</b>"
              );
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
          body.push("Npub: " + nip19.npubEncode(pubkey) + "<br><br>");
          body.push(
            "Number of followers: " + followers.get(pubkey)?.size + "<br>"
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
                body.push(v.write);
                body.push("</td><td>");
                body.push(v.read);
                body.push("</td></tr>");
              }
              body.push("</table>");
            } catch (e) {}
            body.push("<br>Following: <br><br>");
            // horizontal breakable flex
            body.push(
              '<span style="display: flex;  flex-direction: column; justify-content: space-between; gap: 15px ">'
            );
            for (let tag of md.tags
              .slice()
              .sort(
                (a: string[], b: string[]) =>
                  (followers.get(b[1]?.toLocaleLowerCase())?.size || 0) -
                  (followers.get(a[1]?.toLocaleLowerCase())?.size || 0)
              )) {
              let pubkey = tag[1]?.toLowerCase();
              body.push(profile(pubkey));
            }
          }
          body.push("<a href='/'>Home</a> <br>");
          res.write(body.join(""));
          res.end();
        } else {
          res.writeHead(404, {"Content-Type": "text/html"});
          res.end("not found");
        }
      } else if (req.url === "/stats") {
        res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
        res.write("<table><tr><th>ms</th><th>URL</th><th>Date</th></tr>");
        for (let i = 0; i < stats.length; i++) {
          res.write(
            "<tr><td>" +
              stats[i][0] +
              "</td><td>" +
              stats[i][1] +
              "</td><td>" +
              stats[i][2] +
              "</td></tr>"
          );
        }
        res.write("</table>");
      } else if (req.url === "" || req.url === "/") {
        res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
        let body = [];
        body.push(
          "<style>body {background-color: #121212; color: white;}</style>"
        );
        body.push("<style>a {color: #1d9bf0; text-decoration: none;}</style>");
        body.push(
          `<p>rbr.io is a cache for all metadata and contacts served from RAM. It contains ${
            lastCreatedAtAndMetadataPerPubkey.size
          } metadata (probably half of it is fake, TODO: fix) and ${
            lastCreatedAtAndContactsPerPubkey.size
          } contacts. Content can be accessed by HTML, JSON and a relay (on port ${
            root ? 81 : 8082
          }). </p>`
        );
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
      stats.push([Date.now() - start, req.url, Date.now()]);
      if (stats.length > 1000) {
        stats.shift();
      }
    })
    .listen(root ? 80 : 8082);
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
    if (v.size > 0 && !lastCreatedAtAndMetadataPerPubkey.get(k)) {
      r.push(k);
    }
  }
  r.sort((a, b) => (followers.get(b).size || 0) - (followers.get(a).size || 0));
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
  new RelayInfoServer();
  computeFollowers();
  printFollowersWithoutMetadataStatistic();
  console.log(lastCreatedAtAndMetadataPerPubkey.size);
  updateMetadataForPopularAuthors();
} else {
  loadData();
  new RelayInfoServer();
  computeFollowers();
  printFollowersWithoutMetadataStatistic();
  console.log(lastCreatedAtAndMetadataPerPubkey.size);
  httpServe();
}
