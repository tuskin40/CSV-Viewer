(function(){

  "use strict";

  // ---------- State ----------
  let columns = [];        // string[]
  let columnTypes = {};    // col -> 'number' | 'date' | 'text'
  let rows = [];           // array of objects
  let visibleCols = new Set();
  let currentPage = 1;
  let pageSize = 250;
  let idCounter = 1;
  const nextId = () => 'n' + (idCounter++);
  let resultSearch = '';
  let sortColumn = '';
  let sortDirection = 'asc';
  let highlightFilter = false;
  let activeFile = null;

  let filterTree = { id: nextId(), type: 'group', op: 'AND', children: [] };

  // ---------- DOM refs ----------
  const uploadZone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  const delimiterInput = document.getElementById('delimiterInput');
  const skipRowsInput = document.getElementById('skipRowsInput');
  const headerRowInput = document.getElementById('headerRowInput');
  const fileChipHolder = document.getElementById('fileChipHolder');
  const appBody = document.getElementById('appBody');
  const emptyState = document.getElementById('emptyState');
  const statsStrip = document.getElementById('statsStrip');
  const filterRoot = document.getElementById('filterRoot');
  const matchSummary = document.getElementById('matchSummary');
  const filterHighlightToggle = document.getElementById('filterHighlightToggle');
  const colGrid = document.getElementById('colGrid');
  const colSearch = document.getElementById('colSearch');
  const dataTable = document.getElementById('dataTable');
  const rowRangeEl = document.getElementById('rowRange');
  const pageIndicator = document.getElementById('pageIndicator');
  const pageSizeSelect = document.getElementById('pageSizeSelect');
  const sortColumnSelect = document.getElementById('sortColumnSelect');
  const sortDirectionSelect = document.getElementById('sortDirectionSelect');
  const resultSearchInput = document.getElementById('resultSearchInput');
  const resultSearchClear = document.getElementById('resultSearchClear');

  filterHighlightToggle.addEventListener('click', ()=>{
    highlightFilter = !highlightFilter;
    filterHighlightToggle.classList.toggle('active', highlightFilter);
    filterHighlightToggle.setAttribute('aria-pressed', String(highlightFilter));
    currentPage = 1;
    updateMatchSummary();
    renderTable();
  });

  const OPERATORS = {
    text: [
      ['eq','equals'], ['neq','not equals'], ['contains','contains'],
      ['ncontains','does not contain'], ['starts','starts with'], ['ends','ends with'],
      ['empty','is empty'], ['nempty','is not empty']
    ],
    number: [
      ['eq','='], ['neq','≠'], ['gt','>'], ['gte','≥'], ['lt','<'], ['lte','≤'],
      ['between','between'], ['empty','is empty'], ['nempty','is not empty']
    ],
    date: [
      ['eq','on date'], ['before','before'], ['after','after'], ['between','between dates'],
      ['empty','is empty'], ['nempty','is not empty']
    ]
  };

  // ---------- Upload handling ----------
  // CSV files larger than this are rejected before Papa Parse reads them into memory.
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB

  uploadZone.addEventListener('click', (e)=>{
    if(e.target.tagName !== 'BUTTON' && !e.target.closest('.import-options')) fileInput.click();
  });
  uploadZone.addEventListener('dragover', (e)=>{ e.preventDefault(); uploadZone.classList.add('drag'); });
  uploadZone.addEventListener('dragleave', ()=> uploadZone.classList.remove('drag'));
  uploadZone.addEventListener('drop', (e)=>{
    e.preventDefault(); uploadZone.classList.remove('drag');
    if(e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e)=>{
    if(e.target.files.length) handleFile(e.target.files[0]);
  });
  [delimiterInput, skipRowsInput, headerRowInput].forEach(input=>{
    input.addEventListener('change', ()=>{ if(activeFile) handleFile(activeFile); });
  });

  function importSettings(){
    const delimiter = delimiterInput.value === '\\t' ? '\t' : delimiterInput.value;
    const skipRows = Math.max(0, parseInt(skipRowsInput.value, 10) || 0);
    const headerRow = Math.max(0, parseInt(headerRowInput.value, 10) || 0);
    return { delimiter, skipRows, headerRow };
  }

  function handleFile(file){
    if(!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv'){
      toast('That doesn\'t look like a CSV file.');
      return;
    }

    // Check the file size before parsing so oversized files are never loaded into memory.
    if(file.size > MAX_FILE_SIZE){
      const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
      toast(`CSV file is too large (${sizeMb} MB). Maximum allowed size is 10 MB.`);
      return;
    }

    const settings = importSettings();
    if(!settings.delimiter){
      toast('Enter a delimiter, such as a comma, semicolon, pipe, or \\t for tab.');
      return;
    }
    activeFile = file;

    Papa.parse(file, {
      delimiter: settings.delimiter,
      header: false,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: function(results){
        const importedRows = results.data.slice(settings.skipRows);
        if(settings.headerRow > importedRows.length){
          toast(`Header row ${settings.headerRow} is beyond the available rows after skipping ${settings.skipRows}.`);
          return;
        }

        let fields, dataRows;
        if(settings.headerRow === 0){
          const columnCount = importedRows.reduce((max, row)=>Math.max(max, row.length), 0);
          fields = Array.from({length: columnCount}, (_, i)=>`Column ${i + 1}`);
          dataRows = importedRows;
        } else {
          fields = importedRows[settings.headerRow - 1].map((field, i)=>String(field || `Column ${i + 1}`).trim());
          dataRows = importedRows.slice(settings.headerRow);
        }

        const uniqueFields = new Set();
        fields = fields.map((field, i)=>{
          const base = field || `Column ${i + 1}`;
          let name = base, suffix = 2;
          while(uniqueFields.has(name)) name = `${base} (${suffix++})`;
          uniqueFields.add(name);
          return name;
        });
        const data = dataRows.map(row=>Object.fromEntries(fields.map((field, i)=>[field, row[i]])));
        loadData(data, fields, file.name);
      },
      error: function(err){
        toast('Could not parse CSV: ' + err.message);
      }
    });
  }

  function loadData(data, fields, fileName){
    columns = fields.filter(f => f !== undefined && f !== '');
    rows = data;
    columnTypes = detectTypes(columns, rows);

    visibleCols = new Set(columns.slice(0, 8));
    filterTree = { id: nextId(), type:'group', op:'AND', children: [] };
    currentPage = 1;
    resultSearch = '';
    resultSearchInput.value = '';
    sortColumn = '';
    sortDirection = 'asc';

    fileChipHolder.innerHTML = '';
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `<b>${escapeHtml(fileName)}</b> · ${rows.length.toLocaleString()} rows × ${columns.length.toLocaleString()} cols`;
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.title = 'Remove file';
    rm.onclick = (e)=>{ e.stopPropagation(); clearData(); };
    chip.appendChild(rm);
    fileChipHolder.appendChild(chip);

    appBody.classList.remove('hidden');
    emptyState.classList.add('hidden');

    renderStats();
    renderFilterTree();
    renderColumnGrid();
    renderSortOptions();
    renderTable();
  }

  function clearData(){
    columns = []; rows = []; columnTypes = {}; visibleCols = new Set();
    filterTree = { id: nextId(), type:'group', op:'AND', children: [] };
    resultSearch = '';
    resultSearchInput.value = '';
    sortColumn = '';
    sortDirection = 'asc';
    renderSortOptions();
    fileInput.value = '';
    activeFile = null;
    fileChipHolder.innerHTML = '';
    appBody.classList.add('hidden');
    emptyState.classList.remove('hidden');
    statsStrip.innerHTML = '';
  }

  // Date patterns require an explicit separator so plain numbers never qualify.
  const DATE_PATTERNS = [
    /^\d{4}-\d{1,2}-\d{1,2}(T\d{2}:\d{2}(:\d{2})?)?$/,      // 2024-01-31, ISO w/ time
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,                            // 01/31/2024 or 1/5/24
    /^\d{1,2}-\d{1,2}-\d{2,4}$/,                              // 31-01-2024
    /^\d{4}\/\d{1,2}\/\d{1,2}$/,                              // 2024/01/31
    /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/,                    // January 31, 2024
    /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/                       // 31 January 2024
  ];
  function looksLikeDate(v){
    const s = String(v).trim();
    if(!DATE_PATTERNS.some(rx => rx.test(s))) return false;
    const t = Date.parse(s);
    return !isNaN(t);
  }

  function detectTypes(cols, data){
    const types = {};
    const sampleSize = Math.min(data.length, 60);
    cols.forEach(col=>{
      let numericCount = 0, dateCount = 0, nonEmptyCount = 0;
      for(let i=0;i<sampleSize;i++){
        const v = data[i] ? data[i][col] : undefined;
        if(v === undefined || v === null || v === '') continue;
        nonEmptyCount++;
        if(v !== '' && !isNaN(v) && isFinite(v)) numericCount++;
        else if(looksLikeDate(v)) dateCount++;
      }
      if(nonEmptyCount > 0 && numericCount === nonEmptyCount){
        types[col] = 'number';
      } else if(nonEmptyCount > 0 && dateCount === nonEmptyCount){
        types[col] = 'date';
      } else {
        types[col] = 'text';
      }
    });
    return types;
  }

  // ---------- Filter tree rendering ----------
  function renderFilterTree(){
    filterRoot.innerHTML = '';
    filterRoot.appendChild(renderGroup(filterTree, true));
    updateMatchSummary();
  }

  function renderGroup(group, isRoot){
    const el = document.createElement('div');
    el.className = 'group' + (isRoot ? '' : ' nested');

    const head = document.createElement('div');
    head.className = 'group-head';

    const opToggle = document.createElement('div');
    opToggle.className = 'op-toggle';
    ['AND','OR'].forEach(op=>{
      const b = document.createElement('button');
      b.textContent = op;
      b.className = (group.op === op ? 'active' + (op==='OR' ? ' or' : '') : '');
      b.onclick = ()=>{ group.op = op; renderFilterTree(); applyFilters(); };
      opToggle.appendChild(b);
    });

    const label = document.createElement('span');
    label.style.cssText = 'font-size:11px;color:var(--muted);margin-left:2px;';
    label.textContent = isRoot ? 'match all conditions using' : 'group — match using';

    const leftWrap = document.createElement('div');
    leftWrap.style.cssText = 'display:flex;align-items:center;gap:10px;';
    leftWrap.appendChild(opToggle);
    leftWrap.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'group-actions';

    const addCondBtn = document.createElement('button');
    addCondBtn.className = 'btn small';
    addCondBtn.textContent = '+ Condition';
    addCondBtn.disabled = visibleCols.size === 0;
    addCondBtn.title = visibleCols.size === 0 ? 'Make at least one column visible first' : '';
    addCondBtn.onclick = ()=>{
      const firstCol = columns.find(c => visibleCols.has(c)) || '';
      group.children.push({ id:nextId(), type:'condition', column: firstCol, operator:'contains', value:'', value2:'' });
      renderFilterTree(); applyFilters();
    };

    const addGroupBtn = document.createElement('button');
    addGroupBtn.className = 'btn small ghost';
    addGroupBtn.textContent = '+ Nested group';
    addGroupBtn.onclick = ()=>{
      group.children.push({ id:nextId(), type:'group', op:'AND', children:[] });
      renderFilterTree(); applyFilters();
    };

    actions.appendChild(addCondBtn);
    actions.appendChild(addGroupBtn);

    if(!isRoot){
      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger small';
      delBtn.textContent = '✕ Remove group';
      delBtn.onclick = ()=>{ removeNode(filterTree, group.id); renderFilterTree(); applyFilters(); };
      actions.appendChild(delBtn);
    }

    head.appendChild(leftWrap);
    head.appendChild(actions);
    el.appendChild(head);

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'group-items';

    if(group.children.length === 0){
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = isRoot ? 'No conditions yet — showing all rows. Add a condition to start filtering.' : 'Empty group — add a condition or remove it.';
      itemsWrap.appendChild(hint);
    }

    group.children.forEach((child, idx)=>{
      if(idx > 0){
        const sep = document.createElement('div');
        sep.className = 'and-sep';
        sep.textContent = group.op;
        itemsWrap.appendChild(sep);
      }
      if(child.type === 'condition'){
        itemsWrap.appendChild(renderCondition(group, child));
      } else {
        itemsWrap.appendChild(renderGroup(child, false));
      }
    });

    el.appendChild(itemsWrap);
    return el;
  }

  function renderCondition(parentGroup, cond){
    const row = document.createElement('div');
    row.className = 'condition';

    // Column dropdown — scoped to currently visible columns.
    const colSelect = document.createElement('select');
    colSelect.className = 'col-select';
    const visibleList = columns.filter(c => visibleCols.has(c));
    if(!visibleList.includes(cond.column) && cond.column){
      // keep the previously chosen column selectable even if it's since been hidden
      const opt = document.createElement('option');
      opt.value = cond.column;
      opt.textContent = cond.column + ' (hidden)';
      colSelect.appendChild(opt);
    }
    visibleList.forEach(c=>{
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      if(c === cond.column) opt.selected = true;
      colSelect.appendChild(opt);
    });
    colSelect.onchange = ()=>{
      cond.column = colSelect.value;
      const type = columnTypes[cond.column] || 'text';
      if(!OPERATORS[type].some(o=>o[0]===cond.operator)) cond.operator = OPERATORS[type][0][0];
      renderFilterTree(); applyFilters();
    };

    const type = columnTypes[cond.column] || 'text';
    const typeTag = document.createElement('span');
    typeTag.className = 'type-tag';
    typeTag.textContent = type;

    const opSelect = document.createElement('select');
    opSelect.className = 'op-select';
    OPERATORS[type].forEach(([val,label])=>{
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      if(val === cond.operator) o.selected = true;
      opSelect.appendChild(o);
    });
    opSelect.onchange = ()=>{ cond.operator = opSelect.value; renderFilterTree(); applyFilters(); };

    row.appendChild(colSelect);
    row.appendChild(typeTag);
    row.appendChild(opSelect);

    if(cond.operator !== 'empty' && cond.operator !== 'nempty'){
      const makeValInput = (val, onInput)=>{
        const input = document.createElement('input');
        if(type === 'number') input.type = 'number';
        else if(type === 'date') input.type = 'date';
        else input.type = 'text';
        input.className = 'val-input';
        if(type !== 'date') input.placeholder = 'Value…';
        input.value = val;
        input.oninput = onInput;
        return input;
      };

      const valInput = makeValInput(cond.value, ()=>{ cond.value = valInput.value; applyFilters(); });
      row.appendChild(valInput);

      if(cond.operator === 'between'){
        const andLbl = document.createElement('span');
        andLbl.style.cssText = 'font-size:11px;color:var(--muted);';
        andLbl.textContent = 'and';
        const val2Input = makeValInput(cond.value2, ()=>{ cond.value2 = val2Input.value; applyFilters(); });
        if(type === 'number') val2Input.type = 'number';
        row.appendChild(andLbl);
        row.appendChild(val2Input);
      }
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger small';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove condition';
    delBtn.onclick = ()=>{ removeNode(filterTree, cond.id); renderFilterTree(); applyFilters(); };
    row.appendChild(delBtn);

    return row;
  }

  function removeNode(node, id){
    if(node.type !== 'group') return false;
    const idx = node.children.findIndex(c=>c.id===id);
    if(idx > -1){ node.children.splice(idx,1); return true; }
    for(const child of node.children){
      if(child.type==='group' && removeNode(child, id)) return true;
    }
    return false;
  }

  // ---------- Evaluation ----------
  function evaluateGroup(group, row){
    if(group.children.length === 0) return true;
    const results = group.children.map(child=>{
      return child.type === 'group' ? evaluateGroup(child, row) : evaluateCondition(child, row);
    });
    return group.op === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }

  function evaluateCondition(cond, row){
    if(!cond.column) return true;
    const raw = row[cond.column];
    const type = columnTypes[cond.column] || 'text';
    const isEmptyVal = (raw === undefined || raw === null || String(raw).trim() === '');

    if(cond.operator === 'empty') return isEmptyVal;
    if(cond.operator === 'nempty') return !isEmptyVal;
    if(isEmptyVal) return false;

    if(type === 'number'){
      const n = parseFloat(raw);
      const target = parseFloat(cond.value);
      switch(cond.operator){
        case 'eq': return n === target;
        case 'neq': return n !== target;
        case 'gt': return n > target;
        case 'gte': return n >= target;
        case 'lt': return n < target;
        case 'lte': return n <= target;
        case 'between': {
          const lo = Math.min(target, parseFloat(cond.value2));
          const hi = Math.max(target, parseFloat(cond.value2));
          return n >= lo && n <= hi;
        }
        default: return true;
      }
    } else if(type === 'date'){
      const t = Date.parse(raw);
      if(isNaN(t)) return false;
      const target = Date.parse(cond.value);
      switch(cond.operator){
        case 'eq': {
          if(isNaN(target)) return true;
          return sameDay(t, target);
        }
        case 'before': return !isNaN(target) ? t < target : true;
        case 'after': return !isNaN(target) ? t > target : true;
        case 'between': {
          const t2 = Date.parse(cond.value2);
          if(isNaN(target) || isNaN(t2)) return true;
          const lo = Math.min(target, t2), hi = Math.max(target, t2);
          return t >= lo && t <= hi;
        }
        default: return true;
      }
    } else {
      const s = String(raw).toLowerCase();
      const v = String(cond.value).toLowerCase();
      switch(cond.operator){
        case 'eq': return s === v;
        case 'neq': return s !== v;
        case 'contains': return s.includes(v);
        case 'ncontains': return !s.includes(v);
        case 'starts': return s.startsWith(v);
        case 'ends': return s.endsWith(v);
        default: return true;
      }
    }
  }

  function sameDay(t1, t2){
    const a = new Date(t1), b = new Date(t2);
    return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  }

  let filteredRows = [];
  function applyFilters(){
    filteredRows = rows.filter(r => evaluateGroup(filterTree, r));
    currentPage = 1;
    updateMatchSummary();
    renderStats();
    renderTable();
  }

  function updateMatchSummary(){
    const activeConds = countActiveConditions(filterTree);
    const shown = activeConds === 0 ? rows.length : filteredRows.length;
    const mode = highlightFilter && activeConds > 0 ? ' — highlighting matches' : '';
    matchSummary.textContent = `${shown.toLocaleString()} of ${rows.length.toLocaleString()} rows match${mode}`;
  }
  function countActiveConditions(node){
    let c = 0;
    node.children.forEach(ch=>{ c += ch.type==='condition' ? 1 : countActiveConditions(ch); });
    return c;
  }

  // ---------- Column visibility ----------
  function renderColumnGrid(filter){
    colGrid.innerHTML = '';
    const term = (filter || '').toLowerCase();
    columns.filter(c => c.toLowerCase().includes(term)).forEach(col=>{
      const item = document.createElement('label');
      item.className = 'col-item' + (visibleCols.has(col) ? ' checked' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = visibleCols.has(col);
      cb.onchange = ()=>{
        if(cb.checked) visibleCols.add(col); else visibleCols.delete(col);
        item.classList.toggle('checked', cb.checked);
        renderFilterTree(); // column dropdowns depend on visible set
        renderSortOptions(); // sorting is limited to the visible set
        renderTable();
      };
      const span = document.createElement('span');
      span.textContent = col;
      span.title = col;
      item.appendChild(cb);
      item.appendChild(span);
      colGrid.appendChild(item);
    });
  }
  colSearch.addEventListener('input', ()=> renderColumnGrid(colSearch.value));
  document.getElementById('colsAllBtn').onclick = ()=>{ visibleCols = new Set(columns); renderColumnGrid(colSearch.value); renderFilterTree(); renderSortOptions(); renderTable(); };
  document.getElementById('colsNoneBtn').onclick = ()=>{ visibleCols = new Set(); renderColumnGrid(colSearch.value); renderFilterTree(); renderSortOptions(); renderTable(); };
  document.getElementById('colsResetBtn').onclick = ()=>{ visibleCols = new Set(columns.slice(0,8)); renderColumnGrid(colSearch.value); renderFilterTree(); renderSortOptions(); renderTable(); };

  // ---------- Result search (searches values within the already-filtered list) ----------
  resultSearchInput.addEventListener('input', ()=>{
    resultSearch = resultSearchInput.value;
    resultSearchClear.style.display = resultSearch ? 'block' : 'none';
    currentPage = 1;
    renderTable();
  });
  resultSearchClear.addEventListener('click', ()=>{
    resultSearch = '';
    resultSearchInput.value = '';
    resultSearchClear.style.display = 'none';
    renderTable();
  });

  function matchesResultSearch(row, cols, term){
    if(!term) return true;
    const t = term.toLowerCase();
    return cols.some(c=>{
      const v = row[c];
      return v !== undefined && v !== null && String(v).toLowerCase().includes(t);
    });
  }

  // ---------- Sorting (restricted to columns currently shown in the table) ----------
  function renderSortOptions(){
    const visibleList = columns.filter(c => visibleCols.has(c));
    if(!visibleList.includes(sortColumn)) sortColumn = '';

    sortColumnSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'No sorting';
    sortColumnSelect.appendChild(placeholder);
    visibleList.forEach(col=>{
      const option = document.createElement('option');
      option.value = col;
      option.textContent = col;
      option.selected = col === sortColumn;
      sortColumnSelect.appendChild(option);
    });
    sortColumnSelect.value = sortColumn;
    sortColumnSelect.disabled = visibleList.length === 0;
    sortDirectionSelect.value = sortDirection;
    sortDirectionSelect.disabled = visibleList.length === 0;
  }

  sortColumnSelect.addEventListener('change', ()=>{
    sortColumn = sortColumnSelect.value;
    currentPage = 1;
    renderTable();
  });
  sortDirectionSelect.addEventListener('change', ()=>{
    sortDirection = sortDirectionSelect.value;
    currentPage = 1;
    renderTable();
  });

  function sortRows(source){
    if(!sortColumn) return source;
    const type = columnTypes[sortColumn] || 'text';
    const direction = sortDirection === 'desc' ? -1 : 1;
    return source.slice().sort((a, b)=>{
      const av = a[sortColumn], bv = b[sortColumn];
      const aEmpty = av === undefined || av === null || String(av).trim() === '';
      const bEmpty = bv === undefined || bv === null || String(bv).trim() === '';
      if(aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : (aEmpty ? 1 : -1);
      if(type === 'number') return (parseFloat(av) - parseFloat(bv)) * direction;
      if(type === 'date') return (Date.parse(av) - Date.parse(bv)) * direction;
      return String(av).localeCompare(String(bv), undefined, { numeric:true, sensitivity:'base' }) * direction;
    });
  }

  document.getElementById('exportCsvBtn').addEventListener('click', ()=>{
    const cols = columns.filter(c => visibleCols.has(c));
    if(cols.length === 0){
      toast('Select at least one visible column before exporting.');
      return;
    }
    const data = sortRows(countActiveConditions(filterTree) === 0 ? rows : filteredRows);
    const escapeCsvValue = value => {
      const text = value === undefined || value === null ? '' : String(value);
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const csv = [cols, ...data.map(row => cols.map(col => row[col]))]
      .map(record => record.map(escapeCsvValue).join(','))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type:'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'filtered-data.csv';
    link.click();
    URL.revokeObjectURL(url);
  });

  function highlight(text, term){
    if(!term) return document.createTextNode(text);
    const idx = text.toLowerCase().indexOf(term.toLowerCase());
    if(idx === -1) return document.createTextNode(text);
    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + term.length);
    const after = text.slice(idx + term.length);
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(before));
    const mark = document.createElement('mark');
    mark.textContent = match;
    frag.appendChild(mark);
    frag.appendChild(document.createTextNode(after));
    return frag;
  }

  // ---------- Table ----------
  pageSizeSelect.addEventListener('change', ()=>{ pageSize = parseInt(pageSizeSelect.value,10); currentPage = 1; renderTable(); });
  document.getElementById('prevPageBtn').onclick = ()=>{ if(currentPage>1){ currentPage--; renderTable(); } };
  document.getElementById('nextPageBtn').onclick = ()=>{
    const source = getSourceRows();
    const cols = columns.filter(c => visibleCols.has(c));
    const total = source.filter(r => matchesResultSearch(r, cols, resultSearch)).length;
    const maxPage = Math.max(1, Math.ceil(total/pageSize));
    if(currentPage<maxPage){ currentPage++; renderTable(); }
  };

  function getSourceRows(){
    return (highlightFilter || countActiveConditions(filterTree) === 0) ? rows : filteredRows;
  }

  function renderTable(){
    const cols = columns.filter(c => visibleCols.has(c));
    const source = sortRows(getSourceRows().filter(r => matchesResultSearch(r, cols, resultSearch)));
    const total = source.length;
    const maxPage = Math.max(1, Math.ceil(total/pageSize));
    if(currentPage > maxPage) currentPage = maxPage;
    const start = (currentPage-1)*pageSize;
    const pageRows = source.slice(start, start+pageSize);

    dataTable.innerHTML = '';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    const thIdx = document.createElement('th');
    thIdx.textContent = '#';
    trh.appendChild(thIdx);
    cols.forEach(c=>{
      const th = document.createElement('th');
      if(columnTypes[c] === 'number' || columnTypes[c] === 'date') th.className = 'table-value--right';
      th.textContent = c;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    dataTable.appendChild(thead);

    const tbody = document.createElement('tbody');
    if(cols.length === 0){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 1;
      td.style.color = 'var(--muted)';
      td.textContent = 'No columns selected — pick some in the Visible columns panel above.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else if(pageRows.length === 0){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = cols.length+1;
      td.style.color = 'var(--muted)';
      td.textContent = resultSearch ? 'No rows match your search within the filtered results.' : 'No rows match the current filters.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      pageRows.forEach((r, i)=>{
        const tr = document.createElement('tr');
        if(highlightFilter && countActiveConditions(filterTree) > 0 && evaluateGroup(filterTree, r)){
          tr.className = 'filter-match';
        }
        const tdIdx = document.createElement('td');
        tdIdx.textContent = start + i + 1;
        tr.appendChild(tdIdx);
        cols.forEach(c=>{
          const td = document.createElement('td');
          if(columnTypes[c] === 'number' || columnTypes[c] === 'date') td.className = 'table-value--right';
          const v = r[c];
          const text = (v === undefined || v === null) ? '' : String(v);
          td.title = text;
          td.appendChild(highlight(text, resultSearch));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }
    dataTable.appendChild(tbody);

    rowRangeEl.textContent = total === 0 ? 'No rows' : `Showing ${start+1}–${Math.min(start+pageSize,total)} of ${total.toLocaleString()}`;
    pageIndicator.textContent = `Page ${currentPage} / ${maxPage}`;
    document.getElementById('prevPageBtn').disabled = currentPage<=1;
    document.getElementById('nextPageBtn').disabled = currentPage>=maxPage;
  }

  function renderStats(){
    const activeConds = countActiveConditions(filterTree);
    const shown = activeConds === 0 ? rows.length : filteredRows.length;
    statsStrip.innerHTML = `
      <div class="stat-pill">rows <b>${rows.length.toLocaleString()}</b></div>
      <div class="stat-pill">columns <b>${columns.length.toLocaleString()}</b></div>
      <div class="stat-pill filtered">matching <b>${shown.toLocaleString()}</b></div>
    `;
  }

  function toast(msg){
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(()=> t.remove(), 3200);
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

})();


