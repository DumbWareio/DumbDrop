const fs = require("fs");
const path = require("path");
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

function getFiles(dir, basePath = "/") {
  let fileList = [];
  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const fileUrl = path.join(basePath, file).replace(/\\/g, "/");

    if (fs.statSync(filePath).isDirectory()) {
      fileList = fileList.concat(getFiles(filePath, fileUrl));
    } else {
      fileList.push(fileUrl);
    }
  });

  return fileList;
}

function generateAssetManifest() {
  const assets = getFiles(PUBLIC_DIR);
  fs.writeFileSync(path.join(PUBLIC_DIR, "asset-manifest.json"), JSON.stringify(assets, null, 2));
  console.log("Asset manifest generated!", assets);
}

function generatePWAManifest() {
  generateAssetManifest(); // fetched later in service-worker

  const siteTitle = process.env.DUMBDROP_TITLE || process.env.SITE_TITLE || "WickedYoda's DumbDrop";
  const pwaManifest = {
      name: siteTitle,
      short_name: siteTitle,
      description: "A simple file upload application",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#000000",
      icons: [
        {
          src: "/assets/icon.png",
          type: "image/png",
          sizes: "192x192"
        },
        {
          src: "/assets/icon.png",
          type: "image/png",
          sizes: "512x512"
        }
      ],
      orientation: "any"
  };

  fs.writeFileSync(path.join(PUBLIC_DIR, "manifest.json"), JSON.stringify(pwaManifest, null, 2));
  console.log("PWA manifest generated!", pwaManifest);
}

module.exports = { generatePWAManifest };