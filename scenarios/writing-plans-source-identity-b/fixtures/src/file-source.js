import { fingerprintContents } from './source-fingerprint.js';

export class FileImportSource {
  constructor({ locator, contents, parser }) {
    this.locator = locator;
    this.contents = contents;
    this.parser = parser;
  }

  fingerprint() {
    return fingerprintContents(this.contents);
  }

  async *records({ afterRecord = 0 } = {}) {
    let position = 0;
    for (const record of this.parser(this.contents)) {
      position += 1;
      if (position > afterRecord) {
        yield { position, value: record };
      }
    }
  }
}
