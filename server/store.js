'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Minimal JSON document store. Data lives in memory and is flushed to disk
 * (atomically) when a file path is given; pass null for an in-memory store.
 */
class Store {
  constructor(file, seed) {
    this.file = file;
    this.data = null;
    if (file && fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    if (!this.data) {
      this.data = seed();
      this.save();
    }
    this._timer = null;
  }

  static id(prefix) {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
  }

  all(name) {
    if (!this.data[name]) this.data[name] = [];
    return this.data[name];
  }

  get(name, id) {
    return this.all(name).find((d) => d.id === id) || null;
  }

  find(name, predicate) {
    return this.all(name).filter(predicate);
  }

  insert(name, doc, prefix = name.slice(0, 3)) {
    const record = { id: Store.id(prefix), createdAt: new Date().toISOString(), ...doc };
    this.all(name).push(record);
    this.save();
    return record;
  }

  update(name, id, patch) {
    const doc = this.get(name, id);
    if (!doc) return null;
    Object.assign(doc, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return doc;
  }

  remove(name, id) {
    const list = this.all(name);
    const idx = list.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this.save();
    return true;
  }

  /** Debounced atomic write to disk. */
  save() {
    if (!this.file) return;
    if (this._timer) return;
    this._timer = setTimeout(() => this.flush(), 50);
  }

  flush() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
