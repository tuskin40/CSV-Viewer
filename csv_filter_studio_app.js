(function () {
  'use strict';

  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  let idCounter = 1;
  const nextId = () => 'n' + idCounter++;

  const OPERATORS = {
    text: [['eq','equals'],['neq','not equals'],['contains','contains'],['ncontains','does not contain'],['starts','starts with'],['ends','ends with'],['empty','is empty'],['nempty','is not empty']],
    number: [['eq','='],['neq','≠'],['gt','>'],['gte','≥'],['lt','<'],['lte','≤'],['between','between'],['empty','is empty'],['nempty','is not empty']],
    date: [['eq','on date'],['before','before'],['after','after'],['between','between dates'],['empty','is empty'],['nempty','is not empty']]
  };

  const DATE_PATTERNS = [
    /^\d{4}-\d{1,2}-\d{1,2}(T\d{2}:\d{2}(:\d{2})?)?$/,
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
    /^\d{1,2}-\d{1,2}-\d{2,4}$/,
    /^\d{4}\/\d{1,2}\/\d{1,2}$/,
    /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/,
    /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/
  ];

  function looksLikeDate(value) {
    const text = String(value).trim();
    return DATE_PATTERNS.some((pattern) => pattern.test(text)) && !Number.isNaN(Date.parse(text));
  }

  function detectTypes(cols, data) {
    const types = {};
    const sampleSize = Math.min(data.length, 60);
    cols.forEach((col) => {
      let numeric = 0;
      let dates = 0;
      let nonEmpty = 0;
      for (let i = 0; i < sampleSize; i++) {
        const value = data[i] ? data[i][col] : undefined;
        if (value === undefined || value === null || String(value).trim() === '') continue;
        nonEmpty++;
        if (!Number.isNaN(Number(value)) && Number.isFinite(Number(value))) numeric++;
        else if (looksLikeDate(value)) dates++;
      }
      if (nonEmpty && numeric === nonEmpty) types[col] = 'number';
      else if (nonEmpty && dates === nonEmpty) types[col] = 'date';
      else types[col] = 'text';
    });
    return types;
  }

  function sameDay(a, b) {
    const x = new Date(a);
    const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  function evaluateCondition(cond, row, types) {
    if (!cond.column) return true;
    const raw = row[cond.column];
    const type = types[cond.column] || 'text';
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (cond.operator === 'empty') return empty;
    if (cond.operator === 'nempty') return !empty;
    if (empty) return false;

    if (type === 'number') {
      const n = Number(raw);
      const a = Number(cond.value);
      const b = Number(cond.value2);
      switch (cond.operator) {
        case 'eq': return n === a;
        case 'neq': return n !== a;
        case 'gt': return n > a;
        case 'gte': return n >= a;
        case 'lt': return n < a;
        case 'lte': return n <= a;
        case 'between': return n >= Math.min(a, b) && n <= Math.max(a, b);
        default: return true;
      }
    }

    if (type === 'date') {
      const time = Date.parse(raw);
      const target = Date.parse(cond.value);
      if (Number.isNaN(time)) return false;
      switch (cond.operator) {
        case 'eq': return Number.isNaN(target) ? true : sameDay(time, target);
        case 'before': return Number.isNaN(target) ? true : time < target;
        case 'after': return Number.isNaN(target) ? true : time > target;
        case 'between': {
          const target2 = Date.parse(cond.value2);
          if (Number.isNaN(target) || Number.isNaN(target2)) return true;
          return time >= Math.min(target, target2) && time <= Math.max(target, target2);
        }
        default: return true;
      }
    }

    const value = String(raw).toLowerCase();
    const target = String(cond.value).toLowerCase();
    switch (cond.operator) {
      case 'eq': return value === target;
      case 'neq': return value !== target;
      case 'contains': return value.includes(target);
      case 'ncontains': return !value.includes(target);
      case 'starts': return value.startsWith(target);
      case 'ends': return value.endsWith(target);
      default: return true;
    }
  }

  function evaluateGroup(group, row, types) {
    if (!group.children.length) return true;
    const results = group.children.map((child) => child.type === 'group' ? evaluateGroup(child, row, types) : evaluateCondition(child, row, types));
    return group.op === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }

  function filterGroup(group, id) {
    if (group.id === id) return group;
    for (const child of group.children) {
      if (child.type === 'group') {
        const found = filterGroup(child, id);
        if (found) return found;
      }
    }
    return null;
  }

  function removeNode(group, id) {
    const index = group.children.findIndex((child) => child.id === id);
    if (index !== -1) {
      group.children.splice(index, 1);
      return true;
    }
    return group.children.some((child) => child.type === 'group' && removeNode(child, id));
  }

  function countConditions(group) {
    return group.children.reduce((count, child) => count + (child.type === 'condition' ? 1 : countConditions(child)), 0);
  }

  function csvValue(value) {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function filterGroupComponent(group, app) {
    return { group, app };
  }

  function csvViewer() {
    return {
      columns: [], rows: [], columnTypes: {}, visibleCols: new Set(), currentPage: 1, pageSize: 50,
      sortColumn: '', sortDirection: 'asc', resultSearch: '', columnSearch: '', fileName: '', dragging: false,
      toastMessage: '', filterTree: { id: nextId(), type: 'group', op: 'AND', children: [] },

      get hasData() { return this.rows.length > 0 || this.fileName !== ''; },
      get visibleColumns() { return this.columns.filter((column) => this.visibleCols.has(column)); },
      get filteredColumns() {
        const term = this.columnSearch.toLowerCase();
        return this.columns.filter((column) => column.toLowerCase().includes(term));
      },
      get matchingRows() {
        if (!this.rows.length) return [];
        return countConditions(this.filterTree) ? this.rows.filter((row) => evaluateGroup(this.filterTree, row, this.columnTypes)) : this.rows;
      },
      get searchedRows() {
        const term = this.resultSearch.trim().toLowerCase();
        if (!term) return this.matchingRows;
        return this.matchingRows.filter((row) => this.visibleColumns.some((col) => String(row[col] ?? '').toLowerCase().includes(term)));
      },
      get sortedRows() {
        const source = this.searchedRows.slice();
        if (!this.sortColumn) return source;
        const type = this.columnTypes[this.sortColumn] || 'text';
        const direction = this.sortDirection === 'desc' ? -1 : 1;
        return source.sort((a, b) => {
          const av = a[this.sortColumn], bv = b[this.sortColumn];
          const ae = av === undefined || av === null || String(av).trim() === '';
          const be = bv === undefined || bv === null || String(bv).trim() === '';
          if (ae || be) return ae === be ? 0 : (ae ? 1 : -1);
          if (type === 'number') return (Number(av) - Number(bv)) * direction;
          if (type === 'date') return (Date.parse(av) - Date.parse(bv)) * direction;
          return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * direction;
        });
      },
      get maxPage() { return Math.max(1, Math.ceil(this.sortedRows.length / this.pageSize)); },
      get pagedRows() {
        if (this.currentPage > this.maxPage) this.currentPage = this.maxPage;
        const start = (this.currentPage - 1) * this.pageSize;
        return this.sortedRows.slice(start, start + this.pageSize);
      },
      get rowRange() {
        const total = this.sortedRows.length;
        if (!total) return 'No rows';
        const start = (this.currentPage - 1) * this.pageSize + 1;
        return `Showing ${start}–${Math.min(start + this.pageSize - 1, total)} of ${total.toLocaleString()}`;
      },

      handleDrop(event) {
        this.dragging = false;
        const file = event.dataTransfer.files[0];
        if (file) this.handleFile(file);
      },
      handleFile(file) {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') return this.toast('That doesn\'t look like a CSV file.');
        if (file.size > MAX_FILE_SIZE) return this.toast(`CSV file is too large (${(file.size / 1048576).toFixed(2)} MB). Maximum allowed size is 10 MB.`);
        Papa.parse(file, {
          header: true, skipEmptyLines: true, dynamicTyping: false,
          complete: (results) => {
            if (results.errors && results.errors.length) return this.toast('Could not parse CSV: ' + results.errors[0].message);
            this.columns = (results.meta.fields || []).filter(Boolean);
            this.rows = results.data || [];
            this.columnTypes = detectTypes(this.columns, this.rows);
            this.visibleCols = new Set(this.columns.slice(0, 8));
            this.filterTree = { id: nextId(), type: 'group', op: 'AND', children: [] };
            this.currentPage = 1;
            this.resultSearch = '';
            this.columnSearch = '';
            this.sortColumn = '';
            this.sortDirection = 'asc';
            this.fileName = file.name;
          },
          error: (error) => this.toast('Could not parse CSV: ' + error.message)
        });
      },
      clearData() {
        this.columns = []; this.rows = []; this.columnTypes = {}; this.visibleCols = new Set();
        this.filterTree = { id: nextId(), type: 'group', op: 'AND', children: [] };
        this.fileName = ''; this.resultSearch = ''; this.columnSearch = ''; this.sortColumn = '';
        this.currentPage = 1; this.$refs.file.value = '';
      },
      toggleColumn(column) {
        if (this.visibleCols.has(column)) this.visibleCols.delete(column); else this.visibleCols.add(column);
        this.visibleCols = new Set(this.visibleCols);
        if (!this.visibleCols.has(this.sortColumn)) this.sortColumn = '';
        this.normaliseAllConditions(this.filterTree);
      },
      showAllColumns() { this.visibleCols = new Set(this.columns); },
      hideAllColumns() { this.visibleCols = new Set(); this.sortColumn = ''; },
      resetColumns() { this.visibleCols = new Set(this.columns.slice(0, 8)); if (!this.visibleCols.has(this.sortColumn)) this.sortColumn = ''; },
      addCondition(group) {
        const first = this.visibleColumns[0] || this.columns[0] || '';
        group.children.push({ id: nextId(), type: 'condition', column: first, operator: 'contains', value: '', value2: '' });
      },
      addGroup(group) { group.children.push({ id: nextId(), type: 'group', op: 'AND', children: [] }); },
      normaliseCondition(condition) {
        const type = this.columnTypes[condition.column] || 'text';
        if (!OPERATORS[type].some((operator) => operator[0] === condition.operator)) condition.operator = OPERATORS[type][0][0];
      },
      normaliseAllConditions(group) {
        group.children.forEach((child) => child.type === 'group' ? this.normaliseAllConditions(child) : this.normaliseCondition(child));
      },
      operatorsFor(condition) { return OPERATORS[this.columnTypes[condition.column] || 'text']; },
      removeNode(group, id) { removeNode(group, id); },
      filterGroup(group, id) { return filterGroup(group, id); },
      groupTemplate() { return ''; },
      refresh() { this.currentPage = 1; },
      isNumericOrDate(column) { return this.columnTypes[column] === 'number' || this.columnTypes[column] === 'date'; },
      rowNumber(index) { return (this.currentPage - 1) * this.pageSize + index + 1; },
      toast(message) {
        this.toastMessage = message;
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { this.toastMessage = ''; }, 3200);
      },
      exportCsv() {
        const cols = this.visibleColumns;
        if (!cols.length) return this.toast('Select at least one visible column before exporting.');
        const csv = [cols, ...this.sortedRows.map((row) => cols.map((col) => row[col]))].map((row) => row.map(csvValue).join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = 'filtered-data.csv'; link.click();
        URL.revokeObjectURL(url);
      }
    };
  }

  document.addEventListener('alpine:init', () => {
    Alpine.data('csvViewer', csvViewer);
    Alpine.data('filterGroup', filterGroupComponent);
  });
})();
