import fs from "fs";
import mmap from "mmap-utils";

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

export function readLinesMemoryMappedBuffers(
  filePath: string,
  lineCallback: (line: Buffer) => void
): void {
  let fileDescriptor: number | undefined;
  let fileSize: number;
  let buffer: Buffer | undefined;

  try {
    fileDescriptor = fs.openSync(filePath, "r");
    fileSize = fs.fstatSync(fileDescriptor).size;

    buffer = mmap.map(
      fileSize,
      mmap.PROT_READ,
      mmap.MAP_SHARED,
      fileDescriptor,
      0
    );
    mmap.advise(buffer, mmap.MADV_SEQUENTIAL);

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex > -1) {
      const chunk = buffer.subarray(0, newlineIndex);
      lineCallback(chunk);

      buffer = buffer.subarray(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  } catch (err) {
    console.error(`Error reading file: ${err}`);
  } finally {
    if (buffer) {
      //   mmap.unmap(buffer);
    }
    if (fileDescriptor) {
      fs.closeSync(fileDescriptor);
    }
  }
}

export function readLinesMemoryMapped(
  filePath: string,
  lineCallback: (line: string) => void
): void {
  readLinesMemoryMappedBuffers(filePath, (line) => {
    lineCallback(line.toString());
  });
}

// Usage example:
const filePath = "./contacts2.txt";

readLines(filePath, (line) => {
  //   console.log(_line2);
  //   const jsonObj = JSON.parse(line);
  // console.log(jsonObj);
  //   console.log(line.length);
});
