const assert = require('node:assert/strict');
const {
  dropboxFolderKey,
  shareFileFolderKey,
  findClientsSharingFolders,
} = require('./utils/clientFolderIdentity');

let passed = 0;
let failed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error.message}`);
  }
};

const withNamespace = (namespaceId, fn) => {
  const previous = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
  if (namespaceId) process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID = namespaceId;
  else delete process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
    else process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID = previous;
  }
};

const ROOT = 'WOTC';
const SF_ROOT = 'Clients';

console.log('\nDropbox canonical key — equivalent paths must match (namespace inactive):');

withNamespace(null, () => {
  // The P7 case: a relative path (no root) vs the same location written absolute (with root).
  check('relative "Acme" (root prepended) == absolute "/WOTC/Acme"', () => {
    const a = dropboxFolderKey({ name: 'x', dropboxPath: 'Acme', dropboxPathIsAbsolute: false }, ROOT);
    const b = dropboxFolderKey({ name: 'x', dropboxPath: '/WOTC/Acme', dropboxPathIsAbsolute: true }, ROOT);
    assert.equal(a, b);
    assert.equal(a, '/wotc/acme');
  });

  check('relative "Acme/Payroll Files" == absolute "WOTC/Acme/Payroll Files"', () => {
    const a = dropboxFolderKey({ name: 'x', dropboxPath: 'Acme/Payroll Files', dropboxPathIsAbsolute: false }, ROOT);
    const b = dropboxFolderKey({ name: 'x', dropboxPath: 'WOTC/Acme/Payroll Files', dropboxPathIsAbsolute: true }, ROOT);
    assert.equal(a, b);
  });

  check('absolute trailing slash "/WOTC/Acme/" == relative "Acme"', () => {
    const a = dropboxFolderKey({ name: 'x', dropboxPath: '/WOTC/Acme/', dropboxPathIsAbsolute: true }, ROOT);
    const b = dropboxFolderKey({ name: 'x', dropboxPath: 'Acme', dropboxPathIsAbsolute: false }, ROOT);
    assert.equal(a, b);
  });

  check('absolute duplicate slash "/WOTC//Acme" == relative "Acme"', () => {
    const a = dropboxFolderKey({ name: 'x', dropboxPath: '/WOTC//Acme', dropboxPathIsAbsolute: true }, ROOT);
    const b = dropboxFolderKey({ name: 'x', dropboxPath: 'Acme', dropboxPathIsAbsolute: false }, ROOT);
    assert.equal(a, b);
  });

  check('case-insensitive: absolute "/wotc/acme" == relative "Acme"', () => {
    const a = dropboxFolderKey({ name: 'x', dropboxPath: '/wotc/acme', dropboxPathIsAbsolute: true }, ROOT);
    const b = dropboxFolderKey({ name: 'x', dropboxPath: 'Acme', dropboxPathIsAbsolute: false }, ROOT);
    assert.equal(a, b);
  });

  check('empty dropboxPath falls back to name', () => {
    const a = dropboxFolderKey({ name: 'Acme', dropboxPath: '', dropboxPathIsAbsolute: false }, ROOT);
    const b = dropboxFolderKey({ name: 'zzz', dropboxPath: 'Acme', dropboxPathIsAbsolute: false }, ROOT);
    assert.equal(a, b);
  });

  check('different folders stay different: "Acme" != "Acme2"', () => {
    const a = dropboxFolderKey({ name: 'x', dropboxPath: 'Acme', dropboxPathIsAbsolute: false }, ROOT);
    const b = dropboxFolderKey({ name: 'x', dropboxPath: 'Acme2', dropboxPathIsAbsolute: false }, ROOT);
    assert.notEqual(a, b);
  });

  check('a relative path is NOT confused with the same text written absolute', () => {
    // "WOTC/Acme" relative resolves to /WOTC/WOTC/Acme (root prepended) — genuinely
    // different from absolute "/WOTC/Acme". The key must reflect that, not paper over it.
    const rel = dropboxFolderKey({ name: 'x', dropboxPath: 'WOTC/Acme', dropboxPathIsAbsolute: false }, ROOT);
    const abs = dropboxFolderKey({ name: 'x', dropboxPath: '/WOTC/Acme', dropboxPathIsAbsolute: true }, ROOT);
    assert.notEqual(rel, abs);
    assert.equal(rel, '/wotc/wotc/acme');
  });

  check('spaces vs hyphens are NOT normalized: "ZZ A" != "ZZ-A"', () => {
    const a = dropboxFolderKey({ name: 'x', dropboxPath: 'ZZ A', dropboxPathIsAbsolute: false }, ROOT);
    const b = dropboxFolderKey({ name: 'x', dropboxPath: 'ZZ-A', dropboxPathIsAbsolute: false }, ROOT);
    assert.notEqual(a, b);
  });
});

console.log('\nDropbox canonical key — team namespace active (stored root ignored):');

withNamespace('ns:1234567890', () => {
  check('relative "ZZ/A" == absolute "/ZZ/A" and root is ignored', () => {
    const a = dropboxFolderKey({ name: 'x', dropboxPath: 'ZZ/A', dropboxPathIsAbsolute: false }, ROOT);
    const b = dropboxFolderKey({ name: 'x', dropboxPath: '/ZZ/A', dropboxPathIsAbsolute: true }, ROOT);
    assert.equal(a, b);
    assert.equal(a, '/zz/a');
  });

  check('root prefix typed in an absolute path is preserved (not stripped)', () => {
    const a = dropboxFolderKey({ name: 'x', dropboxPath: 'WOTC/ZZ/A', dropboxPathIsAbsolute: false }, ROOT);
    const b = dropboxFolderKey({ name: 'x', dropboxPath: '/WOTC/ZZ/A', dropboxPathIsAbsolute: true }, ROOT);
    assert.equal(a, b);
    assert.equal(a, '/wotc/zz/a');
  });
});

console.log('\nShareFile canonical key:');

check('relative "Acme" (root prepended) == absolute "Clients/Acme"', () => {
  const a = shareFileFolderKey({ name: 'x', shareFilePath: 'Acme', shareFilePathIsAbsolute: false }, SF_ROOT);
  const b = shareFileFolderKey({ name: 'x', shareFilePath: 'Clients/Acme', shareFilePathIsAbsolute: true }, SF_ROOT);
  assert.equal(a, b);
  assert.equal(a, 'clients/acme');
});

check('trailing slash + case: "Clients/Acme/" (abs) == "acme" (rel)', () => {
  const a = shareFileFolderKey({ name: 'x', shareFilePath: 'Clients/Acme/', shareFilePathIsAbsolute: true }, SF_ROOT);
  const b = shareFileFolderKey({ name: 'x', shareFilePath: 'acme', shareFilePathIsAbsolute: false }, SF_ROOT);
  assert.equal(a, b);
});

check('spaces vs hyphens NOT normalized: "ZZ A" != "ZZ-A"', () => {
  const a = shareFileFolderKey({ name: 'x', shareFilePath: 'ZZ A', shareFilePathIsAbsolute: false }, SF_ROOT);
  const b = shareFileFolderKey({ name: 'x', shareFilePath: 'ZZ-A', shareFilePathIsAbsolute: false }, SF_ROOT);
  assert.notEqual(a, b);
});

console.log('\nfindClientsSharingFolders:');

withNamespace(null, () => {
  // subject stores its paths relative (no root); twins store the same locations differently.
  const subject = { _id: 'S', name: 'Subject', dropboxPath: 'Acme', shareFilePath: 'Acme' };
  const others = [
    { _id: 'S', name: 'Subject (self, must be skipped)', dropboxPath: 'Acme', shareFilePath: 'Acme' },
    { _id: 'D', name: 'DropboxTwin', dropboxPath: '/WOTC/Acme', dropboxPathIsAbsolute: true, shareFilePath: 'Different' },
    { _id: 'F', name: 'ShareFileTwin', dropboxPath: 'Different', shareFilePath: 'Clients/acme/', shareFilePathIsAbsolute: true },
    { _id: 'N', name: 'NoOverlap', dropboxPath: 'Other', shareFilePath: 'Other' },
  ];

  check('detects the Dropbox twin only under .dropbox', () => {
    const { dropbox, shareFile } = findClientsSharingFolders(subject, others, {
      dropboxRootPath: ROOT,
      shareFileRootPath: SF_ROOT,
    });
    assert.deepEqual(dropbox.map((c) => c._id).sort(), ['D']);
    assert.deepEqual(shareFile.map((c) => c._id).sort(), ['F']);
  });

  check('no false positives when nothing collides', () => {
    const lonely = { _id: 'L', name: 'Lonely', dropboxPath: 'WOTC/Unique', shareFilePath: 'Clients/Unique' };
    const { dropbox, shareFile } = findClientsSharingFolders(lonely, others, {
      dropboxRootPath: ROOT,
      shareFileRootPath: SF_ROOT,
    });
    assert.equal(dropbox.length, 0);
    assert.equal(shareFile.length, 0);
  });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
