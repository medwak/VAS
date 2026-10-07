'use strict';

// SMS encoding and segmentation (GSM 03.38 7-bit vs UCS-2).

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€\f';

const BASIC_SET = new Set(GSM_BASIC);
const EXT_SET = new Set(GSM_EXTENDED);

/**
 * Analyse a message: which encoding it needs, how many billable
 * segments it takes and how many characters are left in the last segment.
 */
function analyze(text) {
  const message = String(text ?? '');
  let gsmLength = 0;
  let isGsm = true;
  for (const ch of message) {
    if (BASIC_SET.has(ch)) gsmLength += 1;
    else if (EXT_SET.has(ch)) gsmLength += 2;
    else {
      isGsm = false;
      break;
    }
  }

  const encoding = isGsm ? 'GSM-7' : 'UCS-2';
  // UCS-2 counts UTF-16 code units, so emoji count as 2 (JS string length).
  const length = isGsm ? gsmLength : message.length;
  const single = isGsm ? 160 : 70;
  const multi = isGsm ? 153 : 67;

  let segments;
  if (length === 0) segments = 0;
  else if (length <= single) segments = 1;
  else segments = Math.ceil(length / multi);

  const perSegment = segments > 1 ? multi : single;
  const remaining = segments === 0 ? single : segments * perSegment - length;

  return { encoding, length, segments, perSegment, remaining };
}

module.exports = { analyze };
