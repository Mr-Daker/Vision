/** English (India) locale pack — the source language (roadmap V019). */

import type { LocalePack } from "./strings.ts";

export const enIN: LocalePack = {
  code: "en-IN",
  endonym: "English",
  direction: "ltr",
  translation_status: "source",
  strings: {
    "app.name": "Vision",
    "app.tagline": "Report a problem with public infrastructure",
    "app.language_label": "Language",
    "app.translation_pending":
      "This translation was drafted without a native reviewer and may read awkwardly. It is not an official translation.",
    "app.skip_to_form": "Skip to the report form",
    "login.heading": "Choose a demonstration account",
    "login.choose": "Continue as {label}",
    "login.signed_in_as": "Signed in as {label}",
    "login.sign_out": "Sign out",

    "location.heading": "Where is the problem?",
    "location.use_device": "Use my current location",
    "location.locating": "Getting your location…",
    "location.captured_heading": "Location captured by this device",
    "location.captured_note":
      "Your device reported this position. It is recorded together with how accurate the device said it was.",
    "location.accuracy": "The device reported an accuracy of about {metres} m.",
    "location.accuracy_unknown": "The device did not report how accurate this position is.",
    "location.captured_at": "Captured at {time}.",
    "location.manual_heading": "Location you entered yourself",
    "location.manual_note":
      "You typed these coordinates. They are saved as a location you claim, not as location evidence from your device.",
    "location.manual_toggle": "Enter the location myself instead",
    "location.manual_apply": "Use the location I entered",
    "location.latitude": "Latitude",
    "location.longitude": "Longitude",
    "location.permission_denied":
      "This device did not allow location sharing. You can enter the location yourself instead.",
    "location.unavailable":
      "Your location could not be determined right now. You can try again or enter it yourself.",
    "location.unsupported":
      "This browser cannot report a location. Please enter the location yourself.",
    "location.stale_prompt":
      "This location was captured {minutes} minutes ago. If you have moved since then, capture it again.",
    "location.refresh": "Capture the location again",
    "location.clear": "Clear this location",

    "photo.heading": "Add a photo (optional)",
    "photo.choose": "Choose a photo",
    "photo.hint": "A JPEG or PNG image, up to {megabytes} MB.",
    "photo.selected": "Selected: {name} ({kilobytes} KB)",
    "photo.uploading": "Uploading… {percent}%",
    "photo.uploaded": "Photo uploaded and saved.",
    "photo.failed": "The photo did not finish uploading.",
    "photo.retry": "Try the upload again",
    "photo.remove": "Remove this photo",
    "photo.too_large": "That file is larger than {megabytes} MB.",
    "photo.wrong_type": "That file is not a JPEG or PNG image.",

    "describe.heading": "Describe the problem",
    "describe.text_label": "What is wrong? (optional)",
    "describe.text_hint": "A sentence or two is enough. Up to {max} characters.",
    "describe.remaining": "{remaining} characters left",
    "describe.voice_heading": "Or record a short spoken description",
    "describe.voice_record": "Start recording",
    "describe.voice_stop": "Stop recording",
    "describe.voice_recorded": "Recording saved ({seconds} seconds).",
    "describe.voice_unsupported":
      "This browser cannot record audio. Please type your description instead.",
    "describe.voice_alternative": "Typing a description does everything recording does.",
    "describe.voice_permission_denied":
      "This device did not allow microphone access. Please type your description instead.",

    "review.heading": "Check your report before sending",
    "review.location": "Location",
    "review.photo": "Photo",
    "review.description": "Description",
    "review.none": "Not provided",
    "review.submit": "Send report",
    "review.submitting": "Sending…",
    "review.no_categories_note":
      "You are not asked to choose a department, category or severity. That is decided after review, not by you.",

    "receipt.heading": "Your report was saved",
    "receipt.reference": "Reference",
    "receipt.status": "Status",
    "receipt.received_at": "Received at",
    "receipt.saved_note":
      "This report is stored on the demonstration server. You can close this page and it will still be there.",
    "demo.simulated_notice":
      "Identity here is simulated, and every department and recipient is simulated. Nothing you send from this page reaches a real government system.",
    "receipt.not_a_promise":
      "This is a record that the report was received. It is not an official government acknowledgement, and it is not a promise that the problem will be repaired.",
    "receipt.replayed":
      "This reference was already created — your earlier report was not duplicated.",
    "receipt.report_another": "Report another problem",

    "draft.saved": "Saved on this device {time}.",
    "draft.restored": "An unfinished report was restored from this device.",
    "draft.discard": "Discard this draft",
    "draft.consent_heading": "Keep unfinished reports on this device?",
    "draft.consent_explain":
      "If you agree, what you type and the photo you choose are kept in this browser so a lost connection does not lose your report. It stays on this device, is never sent until you send the report, and is deleted after {hours} hours or when you sign out.",
    "draft.consent_allow": "Keep drafts on this device",
    "draft.consent_decline": "Do not keep drafts",
    "draft.expires": "This draft is deleted automatically after {hours} hours.",

    "error.offline": "You appear to be offline. Nothing was sent.",
    "error.session_expired": "Your session ended. Please sign in again — your draft is kept.",
    "error.rate_limited": "Too many requests. Please try again in {seconds} seconds.",
    "error.validation": "Please fix the highlighted fields.",
    "error.server": "The server could not accept the report. Nothing was saved.",
    "error.no_observation":
      "Add a description, a photo or a recording, so there is something to look at besides a location.",
    "error.upload_incomplete": "Finish or remove the photo upload before sending.",
    "error.duplicate_tap": "Your report is already being sent.",
    "tracking.heading": "Your reports",
    "tracking.none": "You have not sent a report from this device yet.",
    "tracking.refresh": "Refresh your reports",
    "tracking.evidence_count": "{count} item(s) of evidence",
    "tracking.no_issue_yet": "Not yet grouped with an issue",
    "tracking.receipt_reference": "Receipt reference: {reference}",
    "tracking.open_receipt": "Open saved receipt",
    "lookup.heading": "Find a saved receipt",
    "lookup.hint":
      "Enter the receipt reference shown after you sent your report. Only receipts belonging to this signed-in account can be opened.",
    "lookup.label": "Receipt reference",
    "lookup.submit": "Find receipt",
    "lookup.searching": "Finding receipt…",
    "lookup.invalid": "Enter the complete receipt reference exactly as it was shown.",
    "lookup.not_found":
      "No receipt was found for this signed-in account. Check the reference and try again.",
    "lookup.found": "Saved receipt",
    "discovery.heading": "Problems reported nearby",
    "discovery.search": "Search near my location",
    "discovery.filter_label": "Category",
    "discovery.filter_all": "All categories",
    "discovery.load_more": "Show more",
    "discovery.open_detail": "Open this issue",
    "discovery.map_heading": "Nearby issue map",
    "discovery.map_note":
      "Approximate coordinate map. Issue markers use rounded public locations; the centre is your search location. This is not a street map.",
    "discovery.map_key_centre": "Search centre",
    "discovery.map_key_issue": "Reported issue",
    "discovery.map_marker": "Map marker {index}: open {reference}, category {category}",
    "discovery.map_summary": "Showing {shown} of {total} results on the coordinate map.",
    "discovery.map_missing":
      "{count} result(s) have no public location and remain available in the list.",
    "discovery.map_outside":
      "{count} rounded location(s) fall outside this displayed extent and remain available in the list.",
    "detail.heading": "Issue details",
    "detail.opened": "First opened",
    "detail.last_evidence": "Most recent evidence",
    "detail.evidence_heading": "Evidence attached to this issue",
    "detail.history_heading": "Infrastructure history",
    "detail.disclosures_heading": "What is not confirmed",
    "detail.not_live": "Not yet connected to a real workflow",
    "detail.close": "Close these details",

    "resolution.heading": "Repair claim",
    "resolution.claim_label": "What the department says was done",
    "resolution.comment_label": "If it is not fixed, say what is still wrong",
    "resolution.comment_hint": "Required if you disagree, so the crew knows what to look at.",
    "resolution.confirm": "It looks fixed",
    "resolution.dispute": "It is not fixed",
    "resolution.reopen_label": "Why should this be reopened?",
    "resolution.reopen": "Reopen this issue",
    "resolution.history_heading": "What has happened so far",
    "resolution.caveat":
      "A confirmed repair means participants agreed the visible problem appears fixed. It is not a professional inspection, engineering certification, safety guarantee, or guarantee that the repair is permanent.",
    "resolution.inspection":
      "This kind of repair is the sort a qualified person should inspect, and no such inspection has happened. Photographs and agreement are not a substitute for one.",
    "resolution.state_claimed":
      "Department staff say the work is done. This is a claim awaiting confirmation, not a verified resolution.",
    "resolution.state_confirmed":
      "People who reported this agreed the visible problem appears fixed.",
    "resolution.state_confirmed_by_reviewer":
      "A reviewer decided in favour of the department\u2019s claim, over the disagreement recorded here. Your disagreement is still on the record.",
    "resolution.state_disputed":
      "Someone who reported this says it is not fixed. A reviewer decides what happens next.",
    "resolution.state_reopened":
      "This was reopened after being confirmed, so it is an open problem again.",
    "resolution.progress":
      "{recorded} of {required} confirmations recorded, under policy {version}.",
    "resolution.progress_disputed": "{disputes} dispute recorded, under policy {version}.",
    "resolution.evidence_pending":
      "A completion photograph was recorded, but it has no approved version yet, so there is nothing that may be shown.",
    "resolution.evidence_photo": "Completion photograph",
    "resolution.blocked_not_participant":
      "Only people whose report counts on this issue can answer this claim.",
    "resolution.blocked_already_answered": "You have already answered this claim once.",
    "resolution.blocked_no_claim": "There is no repair claim waiting for an answer right now.",
    "resolution.blocked_policy":
      "For this kind of problem the policy does not take citizen confirmation.",
    "resolution.dispute_needs_reason": "Say what is still wrong before sending this back.",
    "resolution.reopen_needs_reason": "Say why this should be reopened.",
    "resolution.saved_confirmed": "Your confirmation was recorded.",
    "resolution.saved_disputed": "Your disagreement was recorded and the claim is now disputed.",
    "resolution.saved_reopened": "This issue was reopened and is no longer counted as closed.",
    "candidate.question": "Is this the same problem you are reporting?",
    "candidate.summary": "{reference}, first reported {date}",
    "candidate.summary_near": "{reference}, first reported {date}, near {place}",
    "candidate.participants_one": "1 person reported this",
    "candidate.participants_many": "{count} people reported this",
    "candidate.distance_label": "about {metres} m from where you reported",
    "candidate.opened_label": "First reported {date}",
    "candidate.confirm": "Yes, it is the same problem",
    "candidate.reject": "No, it is a different problem",
    "candidate.confirm_consequence":
      "Your report is added to this one. Your entry stays yours, and it is counted once.",
    "candidate.reject_consequence":
      "Your report stays separate and gets its own reference. Nothing you sent is deleted.",
    "candidate.alias_note":
      "This report was merged with another one, so the reference shown here may differ from the one you saw earlier. Nothing was removed.",
    "candidate.heading": "Is this the same problem?",
    "candidate.existing": "Existing report",
    "candidate.opened": "First reported",
    "candidate.distance": "Distance",
    "candidate.previews_heading": "Photographs on the existing report",
    "candidate.choices_heading": "What each answer does",
    "candidate.close": "Answer this later",
    "candidate.answered": "Your answer was recorded.",

    // Evidence rail (V019). Stage names match real lifecycle states in
    // packages/domain/src/transitions.ts — there is no "verified" state, and
    // claiming one here would contradict what the product says elsewhere.
    "rail.aria_label": "Report status",
    "rail.location_label": "Location Evidence",
    "rail.location_empty": "Waiting for location",
    "rail.evidence_label": "Evidence",
    "rail.evidence_empty": "Add evidence to analyse",
    "rail.nearby_label": "Nearby",
    "rail.nearby_empty": "Locate to see nearby reports",
    "rail.nearby_count": "{count} nearby",
    "rail.pipeline_label": "Pipeline",
    "rail.field_coordinates": "Coordinates",
    "rail.field_accuracy": "Accuracy",
    "rail.field_source": "Source",
    "rail.field_captured": "Captured",
    "rail.field_file": "File",
    "rail.field_size": "Size",
    "rail.source_device": "Measured by device",
    "rail.source_manual": "Placed by hand",
    "rail.accuracy_unstated": "Not stated",
    "rail.stage_captured": "Captured",
    "rail.stage_checked": "Checked",
    "rail.stage_matched": "Matched",
    "rail.stage_routed": "Routed",
    "rail.pipeline_note": "Departments in this build are simulated.",
  },
};
