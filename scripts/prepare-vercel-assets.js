"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const output = path.join(root, "public");
const assets = [
    "research.html",
    "researchpart2.css",
    "part3.script.js",
    "sti-logo.png",
    "Index.html"
];

fs.mkdirSync(output, { recursive: true });
for (const asset of assets) {
    fs.copyFileSync(path.join(root, asset), path.join(output, asset));
}
console.log(`Prepared ${assets.length} static assets for Vercel.`);
