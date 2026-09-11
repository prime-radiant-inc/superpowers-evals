export class ImportStore {
  constructor(database) {
    this.database = database;
  }

  // Rows and an optional checkpoint are committed by one database transaction.
  // Keeping this atomic prevents a crash from advancing progress without rows,
  // or writing rows without the progress needed to avoid replaying them.
  async commitBatch({ rows, checkpoint }) {
    await this.database.transaction(async (transaction) => {
      await transaction.insertRows(rows);
      if (checkpoint !== null) {
        await transaction.saveCheckpoint(checkpoint);
      }
    });
  }

  async loadCheckpoint(importId) {
    return this.database.findCheckpoint(importId);
  }
}
