const nlp = require('compromise');
const camelcaseKeys = require('camelcase-keys').default;

/**
 * Get different forms of a verb
 * @param {string} verb - The base verb (e.g., "start", "remove")
 * @returns {object} - { gerund, past }
 */
function conjugate(verb) {
  return camelcaseKeys(nlp(verb).verbs().conjugate()[0]);
}

module.exports = {
	conjugate
};
