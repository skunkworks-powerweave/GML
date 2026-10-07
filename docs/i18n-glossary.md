# Interface translation: glossary and rules

The interface is in English (`en`), Hindi (`hi`, Devanagari) and Bhoti (`bo`,
Tibetan script, for Ladakhi/Bhoti speakers in Leh and Kargil). Every string a
person reads comes from a bundle. None is written into a component.

- Chrome (menus, tabs, buttons, status, section gate, login): `apps/web/src/i18n/locales/<locale>.json`
- Page copy, one namespace per product area: `apps/web/src/i18n/locales/<locale>/<namespace>.json`

**The Hindi and Bhoti were drafted by machine translation and have not yet
been reviewed by native speakers.** Review them against this glossary. The
glossary exists so that one reviewer's correction is applied everywhere at
once, and so that the same word is never translated two ways on two pages.

## Adding or changing a string

1. Add the key to all three locale files of the namespace (the key sets must
   match; `tests/behaviour/i18n-bundles.test.ts` fails otherwise).
2. Server component or server action: `const t = await getTranslations("ns")`.
   Client component: `const t = useTranslations("ns")`.
3. Values go in ICU arguments, never by string concatenation:
   `"{count, plural, one {# note} other {# notes}}"`, `"Signed in as {email}"`.
   Word order differs in Hindi and Bhoti, so a sentence is one message, not
   pieces glued together. Links and bold inside a sentence use `t.rich` with a
   tag: `"Read the <link>guide</link>."`.
4. `node scripts/i18n-scan.mjs` must report nothing. A string that must stay
   English (a code, a file format, an example value) carries an
   `i18n-ignore` comment saying why.

Not translated: what people type or an administrator loads (names, school
names, module titles, notes, form questions that come from the database),
and names and codes: GML, Goldenmile, RTT, TKT, TTT, SCORM, WhatsApp, CSV,
PDF, Q1–Q4, URLs, email addresses.

## Style

| | Hindi | Bhoti |
|---|---|---|
| Script | Devanagari | Tibetan (U+0F00–U+0FFF) |
| Register | Polite आप; requests end in "…करें" / "…दें" | Polite requests end in "…གནང་རོགས།" |
| Loanwords | Use the ones Indian schools use, written in Devanagari: वीडियो, फॉर्म, लिंक, पासवर्ड, अपलोड, ईमेल | Prefer Tibetan terms below; keep brand names in Latin |
| Sentence end | । | ། (shad) |
| Numbers | Latin digits | Tibetan digits in fixed text (༡༢); arguments format themselves |

## Terms

| English | Hindi | Bhoti |
|---|---|---|
| Classroom observation | कक्षा अवलोकन | འཛིན་གྲྭའི་བལྟ་ཞིབ། |
| observation | अवलोकन | བལྟ་ཞིབ། |
| observation cycle | अवलोकन चक्र | བལྟ་ཞིབ་སྐོར། |
| observer | अवलोकनकर्ता | བལྟ་ཞིབ་མཁན། |
| nominate / nominated | नामांकित करें / नामांकित | འོས་བསྡུ། / འོས་བསྡུ་བྱས་ཟིན། |
| pre-observation form | अवलोकन-पूर्व फॉर्म | བལྟ་ཞིབ་སྔོན་གྱི་ཤོག་བྱང་། |
| post-observation form | अवलोकन-पश्चात फॉर्म | བལྟ་ཞིབ་རྗེས་ཀྱི་ཤོག་བྱང་། |
| sign off / signed off | हस्ताक्षर करके बंद करें / हस्ताक्षरित | མིང་རྟགས་བཀོད་ནས་མཇུག་སྒྲིལ། / མིང་རྟགས་བཀོད་ཟིན། |
| baseline / developmental / evaluative | आधार रेखा / विकासात्मक / मूल्यांकनात्मक | གཞི་རྩ། / ཡར་རྒྱས། / དཔྱད་ཞིབ། |
| teacher | शिक्षक | དགེ་རྒན། |
| mentor | मेंटर | ལམ་སྟོན་པ། |
| mentee | मेंटी | ལམ་སྟོན་མི། |
| mentorship | मेंटरशिप | ལམ་སྟོན། |
| pairing | जोड़ी | ཟུང་འབྲེལ། |
| commitment | प्रतिबद्धता | ཁས་ལེན། |
| meeting | बैठक | ཚོགས་འདུ། |
| quarter (Q1–Q4) | तिमाही | དུས་ཚིགས། |
| progress check | प्रगति जाँच | ཡར་རྒྱས་ཞིབ་བཤེར། |
| final reflection | अंतिम चिंतन | མཐའ་མའི་བསམ་ཞིབ། |
| note | टिप्पणी | ཟིན་བྲིས། |
| form | फॉर्म | ཤོག་བྱང་། |
| quiz | क्विज़ | ཚོད་ལྟ། |
| question / answer | प्रश्न / उत्तर | དྲི་བ། / ལན། |
| attempt | प्रयास | ཐེངས། |
| score | अंक | ཐོབ་སྐར། |
| pass / not passed | उत्तीर्ण / उत्तीर्ण नहीं | ཐོན། / མ་ཐོན། |
| RTT phase | RTT चरण | RTT དུས་རིམ། |
| module (SCORM) | मॉड्यूल | ལེ་ཚན། |
| subject | विषय | སློབ་ཚན། |
| classroom session (a lesson in a class) | कक्षा सत्र | འཛིན་གྲྭའི་དུས་ཚོད། |
| reading material | पठन सामग्री | ཀློག་དེབ། |
| teach-back | टीच-बैक | ཕྱིར་སློབ། |
| course outline | पाठ्यक्रम रूपरेखा | སློབ་ཚན་གྱི་སྡོམ་གཞི། |
| repository | रिपॉज़िटरी | མཛོད་ཁང་། |
| school | विद्यालय | སློབ་གྲྭ། |
| district / zone | ज़िला / ज़ोन | རྫོང་ཁག / ས་ཁུལ། |
| class / student | कक्षा / विद्यार्थी | འཛིན་གྲྭ། / སློབ་ཕྲུག |
| attendance | उपस्थिति | ཚོགས་འཛུལ། |
| training attendance (teachers at RTT sessions) | प्रशिक्षण उपस्थिति | སྦྱོང་བརྡར་ཚོགས་འཛུལ། |
| student attendance (students in classroom sessions) | विद्यार्थियों की उपस्थिति | སློབ་ཕྲུག་གི་ཚོགས་འཛུལ། |
| video | वीडियो | བརྙན་ཕབ། |
| upload | अपलोड | འགྲེམས་སྤེལ། |
| recording | रिकॉर्डिंग | ཕབ་ཟིན་པའི་བརྙན། |
| transcoding (processing a video) | वीडियो प्रोसेसिंग | བརྙན་ཕབ་བཟོ་བཅོས། |
| user / account | उपयोगकर्ता / खाता | བེད་སྤྱོད་པ། / རྩིས་ཐོ། |
| role | भूमिका | འགན་ཁུར། |
| programme administrator | कार्यक्रम व्यवस्थापक | ལས་གཞིའི་འགན་འཛིན། |
| section password / section gate | सेक्शन पासवर्ड / सेक्शन गेट | ས་ཁོངས་གསང་ཨང་། / ས་ཁོངས་སྒོ། |
| audit log | ऑडिट लॉग | ཞིབ་བཤེར་ལོ་ཐོ། |
| settings | सेटिंग्स | སྒྲིག་འགོད། |
| dashboard | डैशबोर्ड | མདུན་ངོས། |
| inbox / notification | इनबॉक्स / सूचना | ཡིག་སྡུད། / བརྡ་ཐོ། |
| save / cancel / delete / edit | सहेजें / रद्द करें / हटाएँ / संपादित करें | ཉར་ཚགས། / ཕྱིར་འཐེན། / བསུབ། / བསྒྱུར་བཅོས། |
| add / remove | जोड़ें / हटाएँ | སྣོན། / འདོར། |
| submit / send | जमा करें / भेजें | ཕུལ། / གཏོང་། |
| search / filter / all | खोजें / फ़िल्टर / सभी | འཚོལ། / འདེམས་སྒྲུག / ཚང་མ། |
| back / next / previous | वापस / अगला / पिछला | ཕྱིར་ལོག / རྗེས་མ། / སྔོན་མ། |
| view / details | देखें / विवरण | ལྟ་བ། / ཞིབ་ཕྲ། |
| download / export / import | डाउनलोड / निर्यात / आयात | ཕབ་ལེན། / ཕྱིར་འདྲེན། / ནང་འདྲེན། |
| date / time | तारीख़ / समय | ཟླ་ཚེས། / དུས་ཚོད། |
| required / optional | आवश्यक / वैकल्पिक | ངེས་པར་དགོས། / གདམ་ཀ |
| pending / active / complete | लंबित / सक्रिय / पूर्ण | སྒུག་བཞིན། / ཞུགས་བཞིན། / ལེགས་གྲུབ། |
| draft | ड्राफ़्ट | ཟིན་བྲིས་སྔོན་མ། |
| archived | संग्रहीत | ཡིག་མཛོད་དུ་བཞག་ཟིན། |
| loading… | लोड हो रहा है… | ལོངས་བཞིན།… |
| something went wrong / try again | कुछ गड़बड़ हो गई / फिर कोशिश करें | ནོར་འཁྲུལ་ཞིག་བྱུང་། / ཡང་བསྐྱར་ཚོད་ལྟ་གནང་རོགས། |
| nothing yet / none | अभी कुछ नहीं / कोई नहीं | ད་དུང་གང་ཡང་མེད། / གཅིག་ཀྱང་མེད། |
| learner | शिक्षार्थी | སློབ་མ། |
| lesson | पाठ | སློབ་ཁྲིད། |
| grade (school year) | कक्षा | འཛིན་རིམ། |
| school term | टर्म | སློབ་དུས། |
| lesson topic | प्रकरण | བརྗོད་གཞི། |
| step (of the tour) | कदम | གོ་རིམ། |
| feedback | फ़ीडबैक | བསམ་འཆར། |
| rubric | रूब्रिक | ཚད་གཞི། |
| endline | अंतिम आकलन | མཐའ་མའི་ཚོད་དཔག |
| sign-in (a login session) | साइन-इन | ནང་འཛུལ། |
| device | डिवाइस | འཕྲུལ་ཆས། |
| browser | ब्राउज़र | དྲ་བཤར་ཆས། |
| caption | कैप्शन | མཆན་བྱང་། |
| status | स्थिति | གནས་སྟངས། |
| cancelled | रद्द | ཕྱིར་འཐེན་བྱས་ཟིན། |
| ready (to review) | तैयार | གྲ་སྒྲིག་ཟིན། |
| present / absent | उपस्थित / अनुपस्थित | ཚོགས་འཛུལ་བྱས། / ཚོགས་འཛུལ་མ་བྱས། |
| row / column (data tables) | पंक्ति / कॉलम | ཐིག་ཕྲེང་། / ཀ་ཐིག |
| package (SCORM) | पैकेज | ཐུམ་སྒྲིལ། |
| the programme's name | RTT — रिफ़्रेशर शिक्षक प्रशिक्षण | དགེ་རྒན་བསྐྱར་སྦྱོང་། |

### Which form where

- **Classroom session.** A lesson in a classroom is the long form (classroom
  session, कक्षा सत्र, འཛིན་གྲྭའི་དུས་ཚོད།) wherever it names a list, a page, a menu
  item, a tile, a column header or a detail row: a bare "session" is ambiguous
  next to an RTT training session. The bare word is for a count inside a
  sentence ("12 sessions") only. An RTT session stays "RTT session".
- **Attendance.** The word alone is never a menu item. Training attendance
  (teachers at RTT sessions) and student attendance (students in classroom
  sessions) are named apart wherever both could be meant.

### Open for the native reviewer

- **Bhoti དུས་ཚོད།** is used for both "classroom session" (the long form
  འཛིན་གྲྭའི་དུས་ཚོད། keeps it) and "time". A table with a Session column and a Time
  column reads the same word twice. Pick a distinct word for one of them (for
  "session", perhaps ཚོགས་ཐེངས།) and it can be replaced across `bo/*.json` in
  one pass.
- **Bhoti plurals**: CLDR gives Tibetan only the "other" plural form, so
  `{count, plural, …}` messages in `bo` have one branch. Check that the
  counted phrases read naturally.
- Coined technical terms in the admin screens (webhook འབྱོར་ལེན་སྒོ།, token
  lifetime རྟགས་འཛིན་དུས་ཡུན།, slug ཐོ་མིང་།, dead jobs འགག་སྡོད་ལས་ཀ།) are best
  guesses; the admin screens are read by programme staff, who may prefer the
  English term.
