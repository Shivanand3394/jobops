// worker/src/domains/resume/engine.js

import { templates } from './templates/index.js';
import { resumeSchema, getEmptyResume } from './types/resume.js';

export class ResumeEngine {
  /**
   * Initialize with resume data.
   * If data is missing or partial, it merges with the default schema.
   * @param {Object} resumeData - The resume content (JSON Resume format).
   */
  constructor(resumeData) {
    this.state = { ...getEmptyResume(), ...(resumeData || {}) };
    this.templates = templates;
  }


  /**
   * Updates a specific section of the resume state.
   * @param {string} sectionId - The top-level key of the resume section (e.g., 'basics', 'work').
   * @param {*} data - The new data for the section.
   */
  updateSection(sectionId, data) {
    if (!this.state.hasOwnProperty(sectionId)) {
      console.warn(`Attempting to update unknown section: ${sectionId}`);
    }
    this.state[sectionId] = data;
    return this; // Allow chaining
  }

  /**
   * Validates the current resume state against compliance rules.
   * @returns {{isValid: boolean, errors: string[]}}
   */
  validate() {
    const errors = [];
    const basics = this.state.basics || {};

    if (!basics.name) errors.push("Missing Name.");
    if (!basics.email) errors.push("Missing Email.");
    
    // Check for work experience
    if (!this.state.work || this.state.work.length === 0) {
      errors.push("Resume should have at least one work experience.");
    }

    return {
      isValid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Renders the resume using a specified template.
   * @param {string} templateId - The key of the template to use (e.g., 'classic', 'modern').
   * @returns {string} - The generated HTML payload.
   */
  render(templateId = 'classic') {
    const template = this.templates[templateId];
    if (!template) {
      throw new Error(`Template "${templateId}" not found. Available: ${Object.keys(this.templates).join(', ')}`);
    }

    // The template function is expected to take the resume state and return an HTML string.
    return template(this.state);
  }
  
  /**
   * Returns the current state (JSON).
   */
  toJSON() {
    return this.state;
  }
}

