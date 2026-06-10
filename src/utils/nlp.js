import nlp from 'compromise';
import camelcaseKeys from 'camelcase-keys';

/**
 * Get different forms of a verb
 * @param {string} verb - The base verb (e.g., "start", "remove")
 * @returns {object} - { gerund, past }
 */
function conjugate(verb) {
  return camelcaseKeys(nlp(verb).verbs().conjugate()[0]);
}

export {
	conjugate
};
