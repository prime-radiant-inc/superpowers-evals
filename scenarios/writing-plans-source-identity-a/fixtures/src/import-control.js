export class ImportControl {
  constructor(database) {
    this.database = database;
  }

  async requestCancellation(importId, requestedBy) {
    return this.database.requestImportCancellation({ importId, requestedBy });
  }

  async readStatus(importId) {
    return this.database.readImportStatus(importId);
  }
}
