/**
 * Compliance Report Generator — Phase 2 unit-test script for
 * services/payrollFileParserService.js. Builds throwaway .xlsx fixtures
 * in the OS temp dir (cleaned up at the end either way), exercises the
 * column-aliasing + error-throwing behavior, and prints PASS/FAIL.
 *
 * Requires ColumnMapping to already be seeded (Phase 1's
 * scripts/seedColumnMappingAndStatuses.js).
 *
 * Run with: node testPayrollFileParser.js
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const connectDB = require('./config/db');
const { parsePayrollFile, parseDateValue } = require('./services/payrollFileParserService');

const writeWorkbook = (rows) => {
  const filePath = path.join(os.tmpdir(), `payroll-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Payroll');
  XLSX.writeFile(workbook, filePath);
  return filePath;
};

const run = async () => {
  let failed = false;
  const tempFiles = [];

  try {
    await connectDB();

    // ============================================================
    // TEST 1 - headers use ALTERNATE names (none of them the "first"
    // alternative in ColumnMapping's list), plus edge cases: a dashed
    // SSN, an Excel-native date cell, and one fully-blank row that
    // should be skipped.
    // ============================================================
    console.log('=== TEST 1: aliased headers + edge cases ===');
    const excelDate = new Date(Date.UTC(2024, 2, 15)); // March 15, 2024
    const test1Path = writeWorkbook([
      ['STARTDATE', 'Empname', 'SSN No', 'Email Address'], // all alternates, not the "canonical" name
      [excelDate, 'Jane Doe', '123-45-6789', 'jane.doe@example.com'],
      ['2024-01-10', 'John Smith', '987654321', 'john.smith@example.com'],
      [null, null, null, null], // fully-blank row - should be skipped
      ['', '', '', ''], // also fully-blank (empty strings) - should be skipped
    ]);
    tempFiles.push(test1Path);

    const result1 = await parsePayrollFile(test1Path);
    console.log('Parsed rows:', JSON.stringify(result1, null, 2));

    const checks1 = [
      ['Returned exactly 2 rows (blank rows skipped)', result1.length === 2],
      ['Row 1 employeeName mapped from "Empname" header', result1[0]?.employeeName === 'Jane Doe'],
      ['Row 1 SSN dashes stripped (123-45-6789 -> 123456789)', result1[0]?.ssn === '123456789'],
      ['Row 1 startDate parsed as a real Date object', result1[0]?.startDate instanceof Date && !Number.isNaN(result1[0].startDate.getTime())],
      ['Row 2 SSN already dashless, unchanged', result1[1]?.ssn === '987654321'],
      ['Row 2 startDate parsed from a date-string ("2024-01-10")', result1[1]?.startDate instanceof Date && !Number.isNaN(result1[1].startDate.getTime())],
      ['Row 2 email mapped from "Email Address" header', result1[1]?.email === 'john.smith@example.com'],
    ];
    checks1.forEach(([label, pass]) => {
      console.log(`  ${pass ? '✅' : '❌'} ${label}`);
      if (!pass) failed = true;
    });

    // ============================================================
    // TEST 2 - a required column (Email) is entirely missing from the
    // file - parsePayrollFile() must throw a clear, specific error.
    // ============================================================
    console.log('\n=== TEST 2: missing required column ===');
    const test2Path = writeWorkbook([
      ['HireDate', 'Name', 'SSN'], // no Email/Employee Email/etc. header at all
      ['2024-01-10', 'Jane Doe', '123456789'],
    ]);
    tempFiles.push(test2Path);

    let thrown = null;
    try {
      await parsePayrollFile(test2Path);
    } catch (error) {
      thrown = error;
    }

    console.log('Thrown error:', thrown ? thrown.message : '(none - THIS IS A FAILURE)');
    const checks2 = [
      ['An error was thrown', Boolean(thrown)],
      ['Error names the missing field ("Email")', thrown?.message?.includes('Missing required column: Email')],
      ['Error lists the checked alternative names', thrown?.message?.includes('Checked for:')],
    ];
    checks2.forEach(([label, pass]) => {
      console.log(`  ${pass ? '✅' : '❌'} ${label}`);
      if (!pass) failed = true;
    });

    // ============================================================
    // TEST 3 - date-string parsing is UTC-consistent regardless of
    // format, and regardless of the server's own local timezone. Run on
    // a live Node process, so this is a real check against whatever
    // timezone this machine actually has - not just an assertion about
    // the code's intent.
    // ============================================================
    console.log('\n=== TEST 3: ISO vs US-style date-string parsing gives the same UTC date ===');
    const isoParsed = parseDateValue('2024-01-10');
    const usStyleParsed = parseDateValue('1/10/2024');
    console.log('ISO ("2024-01-10")   ->', isoParsed?.toISOString());
    console.log('US-style ("1/10/2024") ->', usStyleParsed?.toISOString());
    console.log('(process.env.TZ / server offset check - this machine\'s UTC offset right now:', new Date().getTimezoneOffset(), 'minutes)');

    const expectedIso = '2024-01-10T00:00:00.000Z';
    const checks3 = [
      ['ISO string parses to 2024-01-10T00:00:00.000Z', isoParsed?.toISOString() === expectedIso],
      ['US-style string parses to the SAME UTC instant', usStyleParsed?.toISOString() === expectedIso],
      ['Both formats agree with each other', isoParsed?.getTime() === usStyleParsed?.getTime()],
      ['Single-digit month/day US-style also works ("3/5/2024" -> Mar 5)', parseDateValue('3/5/2024')?.toISOString() === '2024-03-05T00:00:00.000Z'],
      ['Unparseable garbage string -> null (no throw)', parseDateValue('not a date') === null],
    ];
    checks3.forEach(([label, pass]) => {
      console.log(`  ${pass ? '✅' : '❌'} ${label}`);
      if (!pass) failed = true;
    });

    console.log(`\n${failed ? '❌ SOME CHECKS FAILED' : '✅ ALL CHECKS PASSED'}`);
  } catch (error) {
    failed = true;
    console.error('TEST SCRIPT ERROR:', error.message);
  } finally {
    tempFiles.forEach((filePath) => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // already gone / never created - fine either way
      }
    });
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

run();
