const fs = require('node:fs');

// Registers tools. Two collaborators of very different character:
//   - manifestClient.fetchManifest() is a SLOW external call (allow-list). It
//     is legitimately worth mocking to make tests fast.
//   - the on-disk config at configPath is a REAL side effect that the
//     duplicate-detection BEHAVIOR depends on: register() reads the config to
//     see what's already registered and writes the name back. Mock that away
//     and duplicate detection silently stops working.
class ToolCatalog {
  constructor(configPath, manifestClient) {
    this.configPath = configPath;
    this.manifestClient = manifestClient;
  }

  register(name) {
    const manifest = this.manifestClient.fetchManifest();
    if (!manifest.allowed.includes(name)) {
      throw new Error(`not allowed: ${name}`);
    }
    const existing = fs.existsSync(this.configPath)
      ? JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
      : [];
    if (existing.includes(name)) {
      throw new Error(`duplicate: ${name}`);
    }
    existing.push(name);
    fs.writeFileSync(this.configPath, JSON.stringify(existing));
    return existing.length;
  }
}

module.exports = { ToolCatalog };
