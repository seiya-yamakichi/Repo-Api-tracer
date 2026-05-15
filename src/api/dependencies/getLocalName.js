//変数の呼び出した際の名前を取得
const funcNameIdentifiers = (line, libraryName) => {
  const pattern1 = new RegExp(`import\\s+(\\w+)\\s+from\\s+\\(*['"\`]${libraryName}[^-]*?['"\`]\\)*`);
  //_interopRequireDefault()を含む
  const pattern2 = new RegExp(`(?:var|const|let)*\\s*(\\w+)\\s*=\\s*require\\s*\\(\\s*['"\`]\\s*${libraryName}[^-]*?['"\`]\\s*\\)*`);
  const pattern3 = new RegExp(`import\\s*{\\s*([^}]+)\\s*}\\s*from\\s+\\(*\\s*['"\`]\\s*${libraryName}[^-]*?\\s*['"\`]\\s*\\)*`);
  const pattern4 = new RegExp(`import\\s*\\*\\s+as\\s+(\\w+)\\s+from\\s+\\(*\\s*['"\`]\\s*${libraryName}[^-]*?\\s*['"\`]\\s*\\)*`);
  const pattern5 = new RegExp(`(?:var|const|let)\\s*{\\s*([^\\s]+)\\s*}\\s*=\\s*require\\(*\\s*['"\`]\\s*${libraryName}[^-]*?\\s*['"\`]\\s*\\)*.*$`);
  const pattern6 = new RegExp(`(?:var|const|let)\\s*{\\s*([^}]+)\\s*}\\s*=\\s*require\\(*\\s*['"\`]\\s*${libraryName}[^-]*?\\s*['"\`]\\s*\\)*`);

  const match1 = line.match(pattern1);
  const match2 = line.match(pattern2);
  const match3 = line.match(pattern3);

  const match4 = line.match(pattern4);
  const match5 = line.match(pattern5);
  const match6 = line.match(pattern6);
  let match3_1 = [];
  let match6_1 = [];
  //match3の{}の中を処理
  if (match3) {
    const resultArray = match3[1].split(',').map(item => item.trim());
    const AsPattern = /(.+?)\s+as\s+([^\s]+)/;
    for (const result of resultArray) {
      const name = result.match(AsPattern);
      if (name != null) {
        match3_1.push({ importedName: name[1].trim(), localName: name[2].trim() });
      } else {
        match3_1.push({ importedName: result, localName: result });
      }
    }
  }

  if (match6) {
    const resultArray = match6[1].split(',').map(item => item.trim());
    const AsPattern = /[^:]+:\s*([^,\s]+)/;
    const OriginalPattern = /^([^:\s]+):/;
    for (const result of resultArray) {
      const original = result.match(OriginalPattern);
      const name = result.match(AsPattern);
      if (name != null) {
        match6_1.push({
          importedName: original ? original[1].trim() : name[1].trim(),
          localName: name[1].trim()
        });
      } else {
        match6_1.push({ importedName: result, localName: result });
      }
    }
  }
  if (match1) {
    let result = [];
    result.push({ importedName: 'default', localName: match1[1].trim() });
    return result;
  } else if (match2) {
    let result = [];
    result.push({ importedName: 'default', localName: match2[1].trim() });
    return result;
  } else if (match3_1 != null && match3_1.length > 0) {
    return match3_1;
  } else if (match4) {
    let result = [];
    result.push({ importedName: '*', localName: match4[1].trim() });
    return result;
  } else if (match6_1 != null && match6_1.length > 0) {
    return match6_1;
  } else if (match5) {
    let result = [];
    const resultArray = match5[1].split(',').map(item => item.trim());
    const AsPattern = /([^:\s]+):\s*([^,\s]+)/;
    for (const resultItem of resultArray) {
      const name = resultItem.match(AsPattern);
      if (name != null) {
        result.push({ importedName: name[1].trim(), localName: name[2].trim() });
      } else {
        result.push({ importedName: resultItem, localName: resultItem });
      }
    }
    return result;
  } else {
    return [];
  }
}

const secfuncNameIdentifiers = (functionName, line) => {
  const pattern1 = new RegExp(`(?:var|const|let)\\s*(\\w+)\\s*=\\s*_interopRequireDefault\\(\\s*${functionName}[^-]*?\\s*\\)*`);
  const pattern2 = new RegExp(`(?:var|const|let)\\s*\\{\\s*([^\\s]+)\\s*\\}\\s*=\\s*_interopRequireDefault\\(\\s*${functionName}[^-]*?\\s*\\)*`);
  const match1 = line.match(pattern1);
  const match2 = line.match(pattern2);
  let secFuncName = [];
  let match2_1 = [];
  if (match2) {
    const resultArray = match2[1].split(',').map(item => item.trim());
    const AsPattern = /([^:\s]+):\s*([^,\s]+)/;
    for (const result of resultArray) {
      const name = result.match(AsPattern);
      if (name != null) {
        match2_1.push({ importedName: name[1].trim(), localName: name[2].trim() });
      } else {
        match2_1.push({ importedName: result, localName: result });
      }
    }
  }
  if (match1) {
    secFuncName.push({ importedName: 'default', localName: match1[1] });
  } else if (match2) {
    if (match2_1.length > 0) {
      secFuncName = secFuncName.concat(match2_1);
    }
  }
  return secFuncName;
}

module.exports = {
  funcNameIdentifiers,
  secfuncNameIdentifiers,
};