#!/usr/bin/env node
/*
   Met à jour OF_REFRESH_TOKEN partout :
     • localement dans .dev.vars (pour wrangler dev)
     • en production via `wrangler secret put`

   Usage :
     node update-token.js              ← invite à coller le jeton
     node update-token.js <jeton>      ← mise à jour directe
*/
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import readline from "readline";

const TOKEN_RE = /^[a-f0-9]{64}$/;
const ENV_FILE = ".dev.vars";

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

function updateLocal(token) {
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, `# Secrets locaux (wrangler dev)\nOF_REFRESH_TOKEN="${token}"\n`);
    console.log(`  .dev.vars créé avec le jeton.`);
    return;
  }
  let content = readFileSync(ENV_FILE, "utf8");
  if (/^OF_REFRESH_TOKEN=/m.test(content)) {
    content = content.replace(/^OF_REFRESH_TOKEN=.*$/m, `OF_REFRESH_TOKEN="${token}"`);
  } else {
    if (!content.endsWith("\n")) content += "\n";
    content += `OF_REFRESH_TOKEN="${token}"\n`;
  }
  writeFileSync(ENV_FILE, content);
  console.log(`  .dev.vars mis à jour.`);
}

function updateRemote(token) {
  console.log("  Envoi vers Cloudflare Workers …");
  const result = spawnSync("npx", ["wrangler", "secret", "put", "OF_REFRESH_TOKEN"], {
    input: token,
    stdio: ["pipe", "inherit", "inherit"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error("Échec du secret wrangler.");
    process.exit(1);
  }
  console.log("  Secret Cloudflare mis à jour.");
}

async function main() {
  let token = process.argv[2];

  if (!token) {
    token = await ask("Nouveau refresh token (64 hexadécimaux) : ");
  }

  if (!TOKEN_RE.test(token)) {
    console.error(`Jeton invalide : il faut exactement 64 caractères hexadécimaux.`);
    console.error(`Tu le trouves sur openfront.io → F12 → Application → Cookies → refreshToken`);
    process.exit(1);
  }

  console.log(`\nMise à jour de OF_REFRESH_TOKEN…`);
  updateLocal(token);
  updateRemote(token);
  console.log("\nTerminé ! Le token est à jour localement et en production.\n");
}

main();
