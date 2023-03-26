import {nip19} from "nostr-tools";

function npubEncode(pubkey: string) {
  try {
    return nip19.npubEncode(pubkey);
  } catch (e) {
    console.error("invalid pubkey ", pubkey + " called from npubEncode");
    throw new Error("invalid pubkey" + pubkey + e);
  }
}

export function search(
  query: string,
  authors: [string, string, number][],
  lastCreatedAtAndMetadataPerPubkey: Map<string, [number, string]>
): [number, string, string][] {
  if (query.length === 0) {
    return [];
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
      return [];
    } else {
      let firstIndex = middle;
      while (firstIndex > 0 && authors[firstIndex - 1][0].startsWith(query)) {
        firstIndex--;
      }
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
          r2.push([a[2], md[1], npubEncode(a[1])]);
        }
      }
      // @ts-ignore
      return r2;
    }
  }
}
