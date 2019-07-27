
import { readFile } from 'fs';
import { promisify } from 'util';
import { toBigIntBE } from 'bigint-buffer';

const readFileAsync = promisify(readFile);

const RecordType = {
  Debit: 0,
  Credit: 1,
  StartAutopay: 2,
  EndAutopay: 3,
};


/**
 * Buffer value extractor
 * @callback extractor
 * @param {Buffer} buffer - Binary buffer
 * @param {number} offset - Where to start extraction
 * @param {number} nextOffset - Where the next extraction begins
 * @param {number} byte - Number of bytes to extract
 *
 * @returns {string|number|BigInt}
 */

/**
 * Reads values from a buffer and "increments" where to read from next
 *
 * @callback bufferReader
 * @param {Buffer} buffer - Binary buffer
 * @param {number} [offset=0] - Where to begin reading from
 *
 * @returns {[string|number|BigInt, number]} Tuple of extracted value and next offset
 */

/**
 * Takes an extractor and the amount of bytes
 *
 * @param {extractor} extractor - Pulls value out of the supplied buffer given an offset,
 *  the next offset, and the bytes
 * @param {number} byte - The amount of bytes this extractor uses
 *
 * @returns {bufferReader}
*/
function createBufferReader(extractor, byte) {
  const fn = (buf, offset = 0) => {
    const nextOffset = offset + byte;
    const val = extractor(buf, offset, nextOffset, byte);

    return [val, nextOffset];
  }

  fn.isStandard = true;

  return fn;
}

/**
 * Creates an Object of byte key with associated bufferReader
 *
 * @param {number[]} bytes - An array of numbers that correspond to bytes (1,4,8)
 * @param {extractor} extractor - The standard extractor for a type
 *
 * @returns {Object.<number, bufferReader>} Lookup table for byte functions of a type
 */
function createBufferReaders(bytes, extractor) {
  return bytes.reduce((acc, byte) => (acc[byte] = createBufferReader(extractor, byte),acc), {});
}

const strExtractor = (buf, offset, nextOffset, byte) => buf.slice(offset, nextOffset).toString();
const str = createBufferReaders([4], strExtractor);

function intExtractor(buf, offset, nextOffset, byte) {
  if (byte <= 4) {
    return buf.readUIntBE(offset, byte)
  }
  else {
    return toBigIntBE(buf.slice(offset, nextOffset));
  }
}

const uint = createBufferReaders([1,4,8], intExtractor);

const doubleExtractor = (buf, offset, nextOffset, byte) => buf.readDoubleBE(offset);
const double = createBufferReader(doubleExtractor, 8);

const nope = (buf, offset) => [null, offset];

/**
 * Operation
 * @typedef {Object} Operation
 * @property {string} key - Name of the field.
 * @property {bufferReader|customBufferReader|Operation[]} op - Operations to perform to extract value(s) for the key.
 */

/**
 * Takes an object comprised of keys that contain bufferReader|customBufferReader|[struct] and
 * turns them into an array of operations
 *
 * @param {Object<string, bufferReader|customBufferReader|[struct]} struct
 *
 * @returns {Operation[]} All operations needed to extract all data for a struct
 */
function convertStructToBufferOps(struct) {
  return Object.entries(struct).reduce((acc, [key, val]) => {
    let op = val;
    if (typeof val === 'object') {

      op = { ops: convertStructToBufferOps(val.struct), until: val.until };
    }

    acc.push({ key, op });
    return acc;
  },[]);
}

/**
 * Runs through Operations to create a Object that will represent a struct
 *
 * @param {Buffer} buf  - Binary buffer to extract values from
 * @param {Operation[]} ops - All operations we want to perform to extract values
 * @param {number} [offset=0] - Where to begin reading from the buffer
 *
 * @returns {Object} Contains the data for operations and the next offset to start from
 */
function executeBufferOps(buf, ops, offset = 0) {
  return ops.reduce((acc, { key, op }) => {
    if (typeof op === 'function') {
      const [ val, offset ] = op.isStandard ? op(buf, acc.offset) : op(buf, acc.offset, acc.data);
      acc.data[key] = val;
      acc.offset = offset;
    }
    else if (typeof op === 'object') {
      const { ops, until: untilField } = op;
      let cur = _ => acc.offset;
      let until = buf.length;

      if (untilField) {
        cur = _ => vals.length;
        until = acc.data[untilField];
      }

      const vals = [];
      while (cur() < until) {
        const { data, offset } = executeBufferOps(buf, ops, acc.offset);
        vals.push(data);
        acc.offset = offset;
      }

      acc.data[key] = vals;
    }

    return acc;
  }, { data: {}, offset });
}

/**
 * Parses the buffer into an Object that fits the required struct
 *
 * @param {Buffer} buf
 * @param {Object<string, bufferReader|customBufferReader|struct[]} struct
 *
 * @returns {Object} Fully hydrated Object that looks like the struct
 */
function parseBufferToStruct(buf, struct) {
  const ops = convertStructToBufferOps(struct);
  return executeBufferOps(buf, ops).data
}

const arrayOf = (struct, until) => ({ struct, until });

/*
Header:

| 4 byte magic string "MPS7" | 1 byte version | 4 byte (uint32) # of records |

The header contains the canonical information about how the records should be processed.
Note: there are fewer than 100 records in `txnlog.dat`.
*/
const headerStruct = {
  magicString: str[4],
  version: uint[1],
  recordCount: uint[4],
};

/*
Record:

| 1 byte record type enum | 4 byte (uint32) Unix timestamp | 8 byte (uint64) user ID |

Record type enum:

* 0x00: Debit
* 0x01: Credit
* 0x02: StartAutopay
* 0x03: EndAutopay

For Debit and Credit record types, there is an additional field, an 8 byte
(float64) amount in dollars, at the end of the record.

All multi-byte fields are encoded in network byte order.
*/
const recordStruct = {
  recordType: uint[1],
  timestamp: uint[4],
  userId: uint[8],
  dollarAmount: (buf, offset, record) => record.recordType === RecordType.Debit || record.recordType === RecordType.Credit ?
    double(buf, offset) : [null, offset],
};

const txnLogStruct = {
  ...headerStruct,
  records: arrayOf(recordStruct, 'recordCount')
}

function readTxnLog(log) {
  return readFileAsync(`./${log}.dat`);
}

/**
 *
 * @param {string} log - Name of the log file
 *
 * @returns {Object} Log parsed into Object
 */
async function parseTxnLog(log) {
  const buf = await readTxnLog(log);
  return parseBufferToStruct(buf, txnLogStruct);
}

const recordFilter = (type) => _ => _.recordType === type;
const addDollarAmount = (acc, _) => acc + _.dollarAmount;

export default async function run() {
  const { records } = await parseTxnLog('txnlog');

  const debitTotal = records.filter(recordFilter(RecordType.Debit)).reduce(addDollarAmount, 0);
  console.log('What is the total amount in dollars of debits?', debitTotal);

  const creditTotal = records.filter(recordFilter(RecordType.Credit)).reduce(addDollarAmount, 0);
  console.log('What is the total amount in dollars of credits?', creditTotal);

  const startAutopayCount = records.filter(recordFilter(RecordType.StartAutopay)).length;
  console.log('How many autopays were started?', startAutopayCount);

  const endAutopayCount = records.filter(recordFilter(RecordType.EndAutopay)).length;
  console.log('How many autopays were ended?', endAutopayCount);

  const userBalanceRecords = records.filter(_ => _.userId === 2456938384156277127n && (_.recordType === RecordType.Debit || _.recordType === RecordType.Credit));
  const userBalance = userBalanceRecords.reduce((acc, _) => _.recordType === RecordType.Credit ? acc + _.dollarAmount : acc - _.dollarAmount, 0);
  console.log('What is balance of user ID 2456938384156277127?', userBalance);
}

run();
