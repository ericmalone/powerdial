// Fallback database driver using Node's built-in SQLite (node:sqlite), with the small slice of the
// better-sqlite3 API this app uses. Used automatically when better-sqlite3 can't be installed
// (for example on Windows without build tools). Nothing to configure.
const { DatabaseSync } = require('node:sqlite');

class Database {
  constructor(file) { this._db = new DatabaseSync(file); this._depth = 0; }
  exec(sql) { this._db.exec(sql); return this; }
  prepare(sql) {
    const st = this._db.prepare(sql);
    return {
      run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
    };
  }
  pragma(s) { this._db.exec('PRAGMA ' + s); return []; }
  transaction(fn) {
    const self = this;
    return function (...args) {
      const name = 'sp' + self._depth;
      self._db.exec(self._depth ? `SAVEPOINT ${name}` : 'BEGIN');
      self._depth++;
      try {
        const r = fn.apply(this, args);
        self._depth--;
        self._db.exec(self._depth ? `RELEASE ${name}` : 'COMMIT');
        return r;
      } catch (e) {
        self._depth--;
        try { self._db.exec(self._depth ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK'); } catch { }
        throw e;
      }
    };
  }
  async backup(file) { this._db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`); }
  close() { this._db.close(); }
}
module.exports = Database;
