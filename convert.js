let data = JSON.parse(require("fs").readFileSync("contacts2.json", "utf8"));
// write entries separated by lines
const fs = require("fs");
// open new file
let fd = fs.openSync("contacts2.txt", "w");
// write each entry in js object
Object.entries(data).forEach((entry) => {
  fs.writeSync(fd, JSON.stringify(entry));
  fs.writeSync(fd, "\n");
});
fs.closeSync(fd);
