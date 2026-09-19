import { createHash } from 'node:crypto';

export class FileImportSource {
  constructor({ path, contents, parser }) {
    this.path = path;
    this.contents = contents;
    this.parser = parser;
  }

  identity() {
    return {
      path: this.path,
      fingerprint: createHash('sha256').update(this.contents).digest('hex'),
    };
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
