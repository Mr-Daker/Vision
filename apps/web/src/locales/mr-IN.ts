/**
 * Marathi (India) locale pack (roadmap V019).
 *
 * `translation_status` is `machine_drafted_pending_native_review` and the
 * interface **shows** that to the reader. This is the same discipline the
 * evaluation fixtures use ([V011](../../../../docs/foundation/V011-fixtures-and-sealed-holdout.md)):
 * text drafted without a native reviewer is labelled as such rather than
 * presented as a finished translation. Sign-off by a Marathi speaker is
 * verification pending; nothing here should be read as an approved
 * translation, and the pilot must not ship it unreviewed.
 */

import type { LocalePack } from "./strings.ts";

export const mrIN: LocalePack = {
  code: "mr-IN",
  endonym: "मराठी",
  direction: "ltr",
  translation_status: "machine_drafted_pending_native_review",
  strings: {
    "app.name": "व्हिजन",
    "app.tagline": "सार्वजनिक सुविधांमधील समस्या नोंदवा",
    "app.language_label": "भाषा",
    "app.translation_pending":
      "हे भाषांतर स्थानिक भाषिकाच्या तपासणीशिवाय तयार केले आहे, त्यामुळे ते अडखळणारे वाटू शकते. हे अधिकृत भाषांतर नाही.",
    "app.skip_to_form": "थेट तक्रार फॉर्मवर जा",
    "login.heading": "प्रात्यक्षिकासाठी खाते निवडा",
    "login.choose": "{label} म्हणून पुढे जा",
    "login.signed_in_as": "{label} म्हणून साइन इन केले आहे",
    "login.sign_out": "साइन आउट",

    "location.heading": "समस्या कुठे आहे?",
    "location.use_device": "माझे आताचे ठिकाण वापरा",
    "location.locating": "तुमचे ठिकाण मिळवत आहे…",
    "location.captured_heading": "या उपकरणाने नोंदवलेले ठिकाण",
    "location.captured_note":
      "तुमच्या उपकरणाने हे ठिकाण नोंदवले. उपकरणाने सांगितलेल्या अचूकतेसह ते जतन केले जाते.",
    "location.accuracy": "उपकरणाने सुमारे {metres} मी. अचूकता नोंदवली.",
    "location.accuracy_unknown": "या ठिकाणाची अचूकता उपकरणाने नोंदवली नाही.",
    "location.captured_at": "{time} वाजता नोंदवले.",
    "location.manual_heading": "तुम्ही स्वतः भरलेले ठिकाण",
    "location.manual_note":
      "हे अक्षांश-रेखांश तुम्ही स्वतः भरले आहेत. ते तुमचा दावा म्हणून जतन होतात, उपकरणाकडून मिळालेला ठिकाणपुरावा म्हणून नाही.",
    "location.manual_toggle": "त्याऐवजी ठिकाण स्वतः भरा",
    "location.manual_apply": "मी भरलेले ठिकाण वापरा",
    "location.latitude": "अक्षांश",
    "location.longitude": "रेखांश",
    "location.permission_denied":
      "या उपकरणाने ठिकाण देण्यास परवानगी दिली नाही. तुम्ही ठिकाण स्वतः भरू शकता.",
    "location.unavailable": "आत्ता तुमचे ठिकाण मिळाले नाही. पुन्हा प्रयत्न करा किंवा ते स्वतः भरा.",
    "location.unsupported": "हा ब्राउझर ठिकाण नोंदवू शकत नाही. कृपया ठिकाण स्वतः भरा.",
    "location.stale_prompt":
      "हे ठिकाण {minutes} मिनिटांपूर्वी नोंदवले होते. तुम्ही तेव्हापासून हलले असल्यास ते पुन्हा नोंदवा.",
    "location.refresh": "ठिकाण पुन्हा नोंदवा",
    "location.clear": "हे ठिकाण काढून टाका",

    "photo.heading": "फोटो जोडा (ऐच्छिक)",
    "photo.choose": "फोटो निवडा",
    "photo.hint": "JPEG किंवा PNG प्रतिमा, {megabytes} MB पर्यंत.",
    "photo.selected": "निवडले: {name} ({kilobytes} KB)",
    "photo.uploading": "अपलोड होत आहे… {percent}%",
    "photo.uploaded": "फोटो अपलोड होऊन जतन झाला.",
    "photo.failed": "फोटोचे अपलोड पूर्ण झाले नाही.",
    "photo.retry": "अपलोड पुन्हा करा",
    "photo.remove": "हा फोटो काढून टाका",
    "photo.too_large": "ती फाइल {megabytes} MB पेक्षा मोठी आहे.",
    "photo.wrong_type": "ती फाइल JPEG किंवा PNG प्रतिमा नाही.",

    "describe.heading": "समस्येचे वर्णन करा",
    "describe.text_label": "काय बिघडले आहे? (ऐच्छिक)",
    "describe.text_hint": "एक-दोन वाक्ये पुरेशी आहेत. {max} अक्षरांपर्यंत.",
    "describe.remaining": "{remaining} अक्षरे शिल्लक",
    "describe.voice_heading": "किंवा थोडक्यात बोलून वर्णन नोंदवा",
    "describe.voice_record": "रेकॉर्डिंग सुरू करा",
    "describe.voice_stop": "रेकॉर्डिंग थांबवा",
    "describe.voice_recorded": "रेकॉर्डिंग जतन झाले ({seconds} सेकंद).",
    "describe.voice_unsupported": "हा ब्राउझर आवाज रेकॉर्ड करू शकत नाही. कृपया वर्णन टाइप करा.",
    "describe.voice_alternative": "रेकॉर्डिंगने जे होते ते वर्णन टाइप करूनही पूर्ण होते.",
    "describe.voice_permission_denied":
      "या उपकरणाने माइक वापरण्यास परवानगी दिली नाही. कृपया वर्णन टाइप करा.",

    "review.heading": "पाठवण्यापूर्वी तक्रार तपासा",
    "review.location": "ठिकाण",
    "review.photo": "फोटो",
    "review.description": "वर्णन",
    "review.none": "दिलेले नाही",
    "review.submit": "तक्रार पाठवा",
    "review.submitting": "पाठवत आहे…",
    "review.no_categories_note":
      "विभाग, प्रकार किंवा तीव्रता निवडायला तुम्हाला सांगितले जात नाही. ते तपासणीनंतर ठरते, तुमच्याकडून नाही.",

    "receipt.heading": "तुमची तक्रार जतन झाली",
    "receipt.reference": "संदर्भ क्रमांक",
    "receipt.status": "स्थिती",
    "receipt.received_at": "मिळाल्याची वेळ",
    "receipt.saved_note":
      "ही तक्रार प्रात्यक्षिक सर्व्हरवर साठवली आहे. हे पान बंद केले तरी ती राहील.",
    "receipt.not_a_promise":
      "तक्रार मिळाल्याची ही नोंद आहे. ही शासनाची अधिकृत पावती नाही, आणि दुरुस्तीचे वचनही नाही.",
    "receipt.replayed": "हा संदर्भ आधीच तयार झाला होता — तुमची आधीची तक्रार दुप्पट झाली नाही.",
    "receipt.report_another": "दुसरी समस्या नोंदवा",

    "draft.saved": "या उपकरणावर {time} जतन केले.",
    "draft.restored": "या उपकरणावरून अपूर्ण तक्रार पुन्हा मिळवली.",
    "draft.discard": "हा मसुदा टाकून द्या",
    "draft.consent_heading": "अपूर्ण तक्रारी या उपकरणावर ठेवायच्या का?",
    "draft.consent_explain":
      "तुम्ही परवानगी दिल्यास, तुम्ही टाइप केलेला मजकूर आणि निवडलेला फोटो या ब्राउझरमध्ये ठेवला जातो, म्हणजे इंटरनेट गेले तरी तक्रार हरवत नाही. ते या उपकरणावरच राहते, तुम्ही तक्रार पाठवेपर्यंत कुठेही जात नाही, आणि {hours} तासांनंतर किंवा साइन आउट केल्यावर मिटवले जाते.",
    "draft.consent_allow": "मसुदे या उपकरणावर ठेवा",
    "draft.consent_decline": "मसुदे ठेवू नका",
    "draft.expires": "हा मसुदा {hours} तासांनंतर आपोआप मिटवला जातो.",

    "error.offline": "तुम्ही ऑफलाइन दिसत आहात. काहीही पाठवले गेले नाही.",
    "error.session_expired": "तुमचे सत्र संपले. कृपया पुन्हा साइन इन करा — तुमचा मसुदा जतन आहे.",
    "error.rate_limited": "फार जास्त विनंत्या. कृपया {seconds} सेकंदांनी पुन्हा प्रयत्न करा.",
    "error.validation": "कृपया दर्शवलेली माहिती दुरुस्त करा.",
    "error.server": "सर्व्हरला तक्रार स्वीकारता आली नाही. काहीही जतन झाले नाही.",
    "error.no_observation":
      "वर्णन, फोटो किंवा रेकॉर्डिंग जोडा, म्हणजे ठिकाणाशिवाय पाहण्यासारखे काही असेल.",
    "error.upload_incomplete": "पाठवण्यापूर्वी फोटोचे अपलोड पूर्ण करा किंवा फोटो काढून टाका.",
    "error.duplicate_tap": "तुमची तक्रार आधीच पाठवली जात आहे.",
    "tracking.heading": "तुमचे अहवाल",
    "tracking.none": "तुम्ही या उपकरणावरून अद्याप कोणताही अहवाल पाठवलेला नाही.",
    "tracking.refresh": "तुमचे अहवाल पुन्हा मिळवा",
    "tracking.evidence_count": "{count} पुरावा घटक",
    "tracking.no_issue_yet": "अद्याप कोणत्याही समस्येशी जोडलेले नाही",
    "tracking.receipt_reference": "पावती संदर्भ: {reference}",
    "tracking.open_receipt": "जतन केलेली पावती उघडा",
    "lookup.heading": "जतन केलेली पावती शोधा",
    "lookup.hint":
      "तुम्ही अहवाल पाठवल्यानंतर दाखवलेला पावती संदर्भ भरा. या साइन इन केलेल्या खात्याच्या पावत्याच उघडता येतील.",
    "lookup.label": "पावती संदर्भ",
    "lookup.submit": "पावती शोधा",
    "lookup.searching": "पावती शोधत आहे…",
    "lookup.invalid": "पावती संदर्भ जसा दाखवला होता तसाच पूर्ण भरा.",
    "lookup.not_found":
      "या साइन इन केलेल्या खात्यासाठी पावती सापडली नाही. संदर्भ तपासून पुन्हा प्रयत्न करा.",
    "lookup.found": "जतन केलेली पावती",
    "discovery.heading": "जवळपास नोंदवलेल्या समस्या",
    "discovery.search": "माझ्या ठिकाणाजवळ शोधा",
    "discovery.filter_label": "प्रकार",
    "discovery.filter_all": "सर्व प्रकार",
    "discovery.load_more": "अधिक दाखवा",
    "discovery.open_detail": "ही समस्या उघडा",
    "discovery.map_heading": "जवळपासच्या समस्यांचा नकाशा",
    "discovery.map_note":
      "अंदाजे निर्देशांक नकाशा. समस्यांची चिन्हे सार्वजनिक माहितीसाठी गोल केलेली ठिकाणे वापरतात; मध्यभाग तुमचे शोधाचे ठिकाण आहे. हा रस्त्यांचा नकाशा नाही.",
    "discovery.map_key_centre": "शोधाचे मध्यस्थान",
    "discovery.map_key_issue": "नोंदवलेली समस्या",
    "discovery.map_marker": "नकाशा चिन्ह {index}: {reference}, प्रकार {category} उघडा",
    "discovery.map_summary": "निर्देशांक नकाशावर {total} पैकी {shown} परिणाम दाखवत आहे.",
    "discovery.map_missing":
      "{count} परिणामांसाठी सार्वजनिक ठिकाण उपलब्ध नाही; ते खालील यादीत उपलब्ध आहेत.",
    "discovery.map_outside":
      "{count} गोल केलेली ठिकाणे दाखवलेल्या मर्यादेबाहेर आहेत; ती खालील यादीत उपलब्ध आहेत.",
    "detail.heading": "समस्येचा तपशील",
    "detail.opened": "पहिल्यांदा उघडली",
    "detail.last_evidence": "सर्वात नवीन पुरावा",
    "detail.evidence_heading": "या समस्येला जोडलेला पुरावा",
    "detail.history_heading": "पायाभूत सुविधांचा इतिहास",
    "detail.disclosures_heading": "जे निश्चित झालेले नाही",
    "detail.not_live": "अद्याप प्रत्यक्ष कार्यप्रवाहाशी जोडलेले नाही",
    "detail.close": "हा तपशील बंद करा",

    "resolution.heading": "दुरुस्तीचा दावा",
    "resolution.claim_label": "विभाग म्हणतो की काय काम झाले",
    "resolution.comment_label": "दुरुस्त झाले नसेल, तर काय अजून चुकीचे आहे ते सांगा",
    "resolution.comment_hint": "तुम्ही असहमत असल्यास आवश्यक, जेणेकरून पथकाला काय पाहायचे ते कळेल.",
    "resolution.confirm": "दुरुस्त झालेले दिसते",
    "resolution.dispute": "दुरुस्त झालेले नाही",
    "resolution.reopen_label": "हे पुन्हा का उघडावे?",
    "resolution.reopen": "हा प्रश्न पुन्हा उघडा",
    "resolution.history_heading": "आतापर्यंत काय घडले",
    "resolution.caveat":
      "पुष्टी झालेल्या दुरुस्तीचा अर्थ असा की सहभागींनी मान्य केले की दिसणारी समस्या दुरुस्त झालेली दिसते. ही व्यावसायिक तपासणी, अभियांत्रिकी प्रमाणपत्र, सुरक्षिततेची हमी किंवा दुरुस्ती कायमस्वरूपी राहील याची हमी नाही.",
    "resolution.inspection":
      "अशा प्रकारची दुरुस्ती पात्र व्यक्तीने तपासावी अशी असते, आणि अशी कोणतीही तपासणी झालेली नाही. छायाचित्रे आणि सहमती हा त्याचा पर्याय नाही.",
    "resolution.state_claimed":
      "विभागाचे कर्मचारी म्हणतात की काम झाले आहे. हा पुष्टीच्या प्रतीक्षेतील दावा आहे, पडताळलेले निराकरण नाही.",
    "resolution.state_confirmed":
      "ज्यांनी हे कळवले त्यांनी मान्य केले की दिसणारी समस्या दुरुस्त झालेली दिसते.",
    "resolution.state_confirmed_by_reviewer":
      "\u092f\u0947\u0925\u0947 \u0928\u094b\u0902\u0926\u0935\u0932\u0947\u0932\u094d\u092f\u093e \u0905\u0938\u0939\u092e\u0924\u0940\u091a\u094d\u092f\u093e \u0935\u093f\u0930\u0941\u0926\u094d\u0927, \u090f\u0915\u093e \u092a\u0930\u0940\u0915\u094d\u0937\u0915\u093e\u0928\u0947 \u0935\u093f\u092d\u093e\u0917\u093e\u091a\u094d\u092f\u093e \u0926\u093e\u0935\u094d\u092f\u093e\u091a\u094d\u092f\u093e \u092c\u093e\u091c\u0942\u0928\u0947 \u0928\u093f\u0930\u094d\u0923\u092f \u0918\u0947\u0924\u0932\u093e. \u0924\u0941\u092e\u091a\u0940 \u0905\u0938\u0939\u092e\u0924\u0940 \u0905\u091c\u0942\u0928\u0939\u0940 \u0928\u094b\u0902\u0926\u0940\u0935\u0930 \u0906\u0939\u0947.",
    "resolution.state_disputed":
      "कळवणाऱ्यांपैकी कोणीतरी म्हणतो की हे दुरुस्त झालेले नाही. पुढे काय होईल हे परीक्षक ठरवतात.",
    "resolution.state_reopened":
      "पुष्टी झाल्यानंतर हे पुन्हा उघडले गेले, त्यामुळे ही पुन्हा एक उघडी समस्या आहे.",
    "resolution.progress": "धोरण {version} अंतर्गत, {required} पैकी {recorded} पुष्टी नोंदवल्या.",
    "resolution.progress_disputed": "धोरण {version} अंतर्गत, {disputes} आक्षेप नोंदवला.",
    "resolution.evidence_pending":
      "पूर्णत्वाचे छायाचित्र नोंदवले आहे, परंतु त्याची मंजूर आवृत्ती अद्याप नाही, त्यामुळे दाखवण्यासारखे काही नाही.",
    "resolution.evidence_photo": "पूर्णत्वाचे छायाचित्र",
    "resolution.blocked_not_participant":
      "ज्यांचा अहवाल या प्रश्नावर मोजला जातो तेच या दाव्याला उत्तर देऊ शकतात.",
    "resolution.blocked_already_answered": "तुम्ही या दाव्याला एकदा उत्तर दिले आहे.",
    "resolution.blocked_no_claim": "सध्या उत्तराच्या प्रतीक्षेत कोणताही दुरुस्ती दावा नाही.",
    "resolution.blocked_policy": "अशा प्रकारच्या समस्येसाठी धोरण नागरिकांची पुष्टी घेत नाही.",
    "resolution.dispute_needs_reason": "हे परत पाठवण्यापूर्वी काय अजून चुकीचे आहे ते सांगा.",
    "resolution.reopen_needs_reason": "हे पुन्हा का उघडावे ते सांगा.",
    "resolution.saved_confirmed": "तुमची पुष्टी नोंदवली गेली.",
    "resolution.saved_disputed": "तुमची असहमती नोंदवली गेली आणि आता या दाव्यावर आक्षेप आहे.",
    "resolution.saved_reopened": "हा प्रश्न पुन्हा उघडला गेला आणि आता बंद म्हणून मोजला जात नाही.",
    "candidate.heading": "हीच समस्या आहे का?",
    "candidate.existing": "आधीचा अहवाल",
    "candidate.opened": "पहिल्यांदा कळवले",
    "candidate.distance": "अंतर",
    "candidate.previews_heading": "आधीच्या अहवालातील छायाचित्रे",
    "candidate.choices_heading": "प्रत्येक उत्तराचा काय परिणाम होतो",
    "candidate.close": "नंतर उत्तर द्या",
    "candidate.answered": "तुमचे उत्तर नोंदवले गेले.",

    // Machine-drafted like the rest of this pack, and disclosed as such by
    // `translation_status` — not reviewed by a Marathi speaker.
    "rail.aria_label": "अहवाल स्थिती",
    "rail.location_label": "स्थान पुरावा",
    "rail.location_empty": "स्थानाची प्रतीक्षा",
    "rail.evidence_label": "पुरावा",
    "rail.evidence_empty": "विश्लेषणासाठी पुरावा जोडा",
    "rail.nearby_label": "जवळपास",
    "rail.nearby_empty": "जवळपासचे अहवाल पाहण्यासाठी स्थान घ्या",
    "rail.nearby_count": "जवळपास {count}",
    "rail.pipeline_label": "प्रक्रिया",
    "rail.field_coordinates": "निर्देशांक",
    "rail.field_accuracy": "अचूकता",
    "rail.field_source": "स्रोत",
    "rail.field_captured": "नोंदवले",
    "rail.field_file": "फाइल",
    "rail.field_size": "आकार",
    "rail.source_device": "उपकरणाने मोजले",
    "rail.source_manual": "हाताने ठेवले",
    "rail.accuracy_unstated": "नमूद नाही",
    "rail.stage_captured": "नोंदवले",
    "rail.stage_checked": "तपासले",
    "rail.stage_matched": "जुळवले",
    "rail.stage_routed": "पाठवले",
    "rail.pipeline_note": "या आवृत्तीत विभाग नक्कल केलेले आहेत.",
  },
};
