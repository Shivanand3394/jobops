# GitHub Issues Backlog

## 1. Low-Quality JD Detection  
**Goal:** Implement a system to automatically detect and flag low-quality job descriptions (JDs).  
**Acceptance Criteria:**  
- System can analyze job description text for quality indicators.  
- Flags JDs with a quality score below a certain threshold for review.  
**Notes:** Investigate NLP tools for text analysis to aid in detection.

## 2. Manual JD Flow  
**Goal:** Establish a manual review process for job descriptions.  
**Acceptance Criteria:**  
- Define steps for manual review of JDs.  
- Ensure all reviewers have access to a shared review platform.  
**Notes:** Review process should allow for feedback and improvements.

## 3. Prevent Untitled Jobs  
**Goal:** Ensure all job postings have a title before submission.
**Acceptance Criteria:**  
- Title field is mandatory in job submission form.  
- Alert users if they attempt to submit a job without a title.  
**Notes:** User experience should be tested to ensure clarity.

## 4. Ingest UX Improvements  
**Goal:** Enhance user experience for job ingestion process.  
**Acceptance Criteria:**  
- Conduct user testing to identify pain points.  
- Implement at least three improvements based on feedback.  
**Notes:** Consider collaboration with UX designers.

## 5. Targets Page CRUD  
**Goal:** Create a CRUD interface for managing target job postings.
**Acceptance Criteria:**  
- Users can create, read, update, and delete target jobs.  
- Changes should be reflected in real-time on targets page.  
**Notes:** Ensure proper error handling throughout the interface.

## 6. Rescore Consistency  
**Goal:** Ensure consistency in how jobs are rescored after updates.  
**Acceptance Criteria:**  
- Document current scoring process.  
- Establish a set guideline for rescoring jobs after any changes.  
**Notes:** Keeping a log of changes to review rescoring decisions could be beneficial.

## 7. CORS Tightening
**Goal:** Improve security measures related to Cross-Origin Resource Sharing (CORS).  
**Acceptance Criteria:**  
- Audit current CORS settings and implement stricter policies.  
- Test to ensure only intended origins can access resources.  
**Notes:** Look into best practices for setting CORS in the application context.