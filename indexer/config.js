'use strict';

const { resolve } = require('path');
require('dotenv').config({ path: resolve(__dirname, '.env') });

function getConfig(overrides = {}) {
  const DB_PATH = overrides.db || process.env.DB_PATH || '/messier/.config/index.db';
  const DATASET = overrides.dataset || null;

  const DATASETS = (process.env.DATASETS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const EXCLUDE_DATASETS = (process.env.EXCLUDE_DATASETS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return { DB_PATH, DATASET, DATASETS, EXCLUDE_DATASETS };
}

module.exports = { getConfig };
