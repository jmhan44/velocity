var fs = require('fs');
var path = require('path');

var logger = require('./logger');

// files waiting for scan
var QUEUE = {};

// scanned files
var FILES = {/*
  fullPath: {
    root: 'vm root',
    relPath: 'path relative to root',
    status: 0(normal), 1(notExists), 2(hasVariable),
    variable: [[line, col], ...],
    parents: {fullPath: directive, ...},
    children: {fullPath: [[line, col], ...], ...}
  },
  ...
*/};

// mark if current position is in block comment
var IN_COMMENT;

function scan(fullPath, conf) {
  FILES[fullPath] = QUEUE[fullPath];
  delete QUEUE[fullPath];

  if (FILES[fullPath].status || path.extname(fullPath) != '.vm') {
    return;
  }

  var item = FILES[fullPath];
  var lineReg = /^.*$/gm;
  var depReg = new RegExp('#{?(' +
    conf.directives.join('|') +
    ')}?\\(\\s*([^\\)]+)\\s*\\)', 'g');

  var content = fs.readFileSync(fullPath, {
        encoding: conf.encoding
      }).toString();

  var lineMatch;
  var lineno = 0;
  while ((lineMatch = lineReg.exec(content)) != null) {
    var line = lineMatch[0];
    /*
     * NOTE
     * when lineReg match an empty line, lineReg.lastIndex dose't change
     * we must increase it manually to avoid endless loop
     */
    if (line === '') {
      lineReg.lastIndex++;
    }

    // handle single line comment
    line = line.replace(/##.*$/, '');

    // handle block comment
    if (IN_COMMENT) {
      if (line.indexOf('*#') > -1) {
        line = line.replace(/^.*\*#/, '');
        IN_COMMENT = 0;
      } else {
        line = '';
      }
    } else {
      if (line.indexOf('#*') > -1) {
        line = line.replace(/#\*.*$/, '');
        IN_COMMENT = 1;
      }
    }

    lineno++;
    var matched;

    while ((matched = depReg.exec(line)) != null) {
      var directive = matched[1];

      // -____-" #include may has multiple params
      matched[2].split(/\s+/).forEach(function(cRelPath) {
        var child = addItem(conf.roots, null, cRelPath);
        child.parents[fullPath] = directive;

        var cFullPath = path.join(child.root, child.relPath);
        if (!item.children[cFullPath]) {
          item.children[cFullPath] = [];
        }

        item.children[cFullPath].push([lineno, matched.index]);
      });
    }
  }
}


// fullPath and relPath is a either-or thing
// relPath may be wrapped with quotes
function addItem(roots, fullPath, relPath) {
  var root;
  var status;

  if (fullPath) {
    root = findRoot(roots, fullPath);
    relPath = path.relative(root, fullPath);
    status = fs.existsSync(fullPath) ? 0 : 1;

  } else /* if (relPath)*/{
    var rawRelPath = relPath;
    relPath = cleanRelPath(relPath);
    root = findRoot(roots, null, relPath);
    fullPath = path.join(root, relPath);

    if (hasVariable(rawRelPath)) {
      status = 2;
    } else {
      status = fs.existsSync(fullPath) ? 0 : 1;
    }
  }

  // make sure include path start with '/'
  if (status !== 2 && relPath.indexOf('/')) {
    relPath = '/' + relPath;
  }

  if (!QUEUE[fullPath] && !FILES[fullPath]) {
    QUEUE[fullPath] = {
      root: root,
      relPath: relPath,
      status: status,
      parents: {},
      children: {}
    }
  }

  return QUEUE[fullPath] || FILES[fullPath];
}

// fullPath and relPath is a either-or thing
function findRoot(roots, fullPath, relPath) {
  var i;
  for (i = 0; i < roots.length; i++) {
    var root = roots[i];
    if (fullPath ?
          fullPath.indexOf(root) === 0
          :
          fs.existsSync(path.join(root, relPath))
       ) {
      return root;
    }
  }
  logger.debug('Cannot find root for path <%s>.', fullPath || relPath);
  return roots[0];
}

/*
 * 'path' -> path
 * "path" -> path
 * $path  -> $path
 */
function cleanRelPath(relPath) {
  if (/'|"/.test(relPath)) {
    return relPath.substring(1, relPath.length - 1);
  } else {
    return relPath;
  }
}

/*
 * '$path' -> 0
 * "path"  -> 0
 * "$path" -> 1
 * $path   -> 1
 * path    -> 0
 */
function hasVariable(relPath) {
   return relPath[0] !== "'" && /\$\!?\{?[a-zA-Z].*\}?/.test(relPath)
}


// find out all vm files in root and add them to QUEUE
function search(roots, p, root) {
  root = root || p;
  if (fs.statSync(p).isFile() && path.extname(p) === '.vm') {
    addItem(roots, p);
  } else if(fs.statSync(p).isDirectory()) {
    fs.readdirSync(p).forEach(function(child) {
      search(roots, path.join(p, child), root);
    })
  }
}


// remove all files not in (reverse) dependency tree
function clean(fullPath, recursive) {
  var cleanedData = {};

  if (recursive) {
    function recursiveClean(fullPath) {
      cleanedData[fullPath] = FILES[fullPath];
      Object.keys(FILES[fullPath].parents).forEach(function(pFullPath) {
        recursiveClean(pFullPath);
      })
    }
    recursiveClean(fullPath);

  } else {
    cleanedData[fullPath] = FILES[fullPath];
    Object.keys(FILES[fullPath].parents).forEach(function(pFullPath) {
      cleanedData[pFullPath] = FILES[pFullPath];
    })
  }

  FILES = cleanedData;
  cleanedData = {};
}


module.exports = function (conf) {
  QUEUE = {};
  FILES = {};

  var file = conf.file;
  var roots = conf.roots;

  if (conf.reverse || !file) {
    if (conf.variable && file && !conf.recursive) {
      addItem(roots, file);
      scan(file, conf);
    } else {
      roots.forEach(function(root) {
        search(roots, root);
      });

      Object.keys(QUEUE).forEach(function(fullPath) {
        scan(fullPath, conf);
      })

      if (conf.file) {
        clean(file, conf.recursive);
      }
    }

  } else {
    addItem(roots, file);
    if (conf.recursive) {
      while (Object.keys(QUEUE).length) {
        Object.keys(QUEUE).forEach(function(fullPath) {
          scan(fullPath, conf);
        })
      }
    } else {
      scan(file, conf);
      Object.keys(QUEUE).forEach(function(fullPath) {
        scan(fullPath, conf);
      })
    }
  }

  logger.debug(FILES);
  return FILES;
}
