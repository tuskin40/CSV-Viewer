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
  const DATE_PATTERNS = [/^\d{4}-\d{1,2}-\d{1,2}(T\d{2}:\d{2}(:\d{2})?)?$/,/^\d{1,2}\/\d{1,2}\/\d{2,4}$/,/^\d{1,2}-\d{1,2}-\d{2,4}$/,/^\d{4}\/\d{1,2}\/\d{1,2}$/,/^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/,/^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/];

  function looksLikeDate(value) {
    const text = String(value).trim();
    return DATE_PATTERNS.some((pattern) => pattern.test(text)) && !Number.isNaN(Date.parse(text));
  }
  function detectTypes(cols, data) {
    const types = {};
    const sampleSize = Math.min(data.length, 60);
    cols.forEach((col) => {
      let numeric = 0, dates = 0, nonEmpty = 0;
      for (let i = 0; i < sampleSize; i++) {
        const value = data[i] ? data[i][col] : undefined;
        if (value === undefined || value === null || String(value).trim() === '') continue;
        nonEmpty++;
        if (!Number.isNaN(Number(value)) && Number.isFinite(Number(value))) numeric++;
        else if (looksLikeDate(value)) dates++;
      }
      types[col] = nonEmpty && numeric === nonEmpty ? 'number' : nonEmpty && dates === nonEmpty ? 'date' : 'text';
    });
    return types;
  }
  function sameDay(a, b) { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); }
  function evaluateCondition(cond, row, types) {
    if (!cond.column) return true;
    const raw = row[cond.column], type = types[cond.column] || 'text';
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (cond.operator === 'empty') return empty;
    if (cond.operator === 'nempty') return !empty;
    if (empty) return false;
    if (type === 'number') {
      const n = Number(raw), a = Number(cond.value), b = Number(cond.value2);
      switch (cond.operator) { case 'eq': return n === a; case 'neq': return n !== a; case 'gt': return n > a; case 'gte': return n >= a; case 'lt': return n < a; case 'lte': return n <= a; case 'between': return n >= Math.min(a,b) && n <= Math.max(a,b); default: return true; }
    }
    if (type === 'date') {
      const time = Date.parse(raw), target = Date.parse(cond.value);
      if (Number.isNaN(time)) return false;
      switch (cond.operator) { case 'eq': return Number.isNaN(target) ? true : sameDay(time,target); case 'before': return Number.isNaN(target) ? true : time < target; case 'after': return Number.isNaN(target) ? true : time > target; case 'between': { const t2 = Date.parse(cond.value2); return Number.isNaN(target) || Number.isNaN(t2) ? true : time >= Math.min(target,t2) && time <= Math.max(target,t2); } default: return true; }
    }
    const value = String(raw).toLowerCase(), target = String(cond.value).toLowerCase();
    switch (cond.operator) { case 'eq': return value === target; case 'neq': return value !== target; case 'contains': return value.includes(target); case 'ncontains': return !value.includes(target); case 'starts': return value.startsWith(target); case 'ends': return value.endsWith(target); default: return true; }
  }
  function evaluateGroup(group, row, types) { if (!group.children.length) return true; const results = group.children.map((child) => child.type === 'group' ? evaluateGroup(child,row,types) : evaluateCondition(child,row,types)); return group.op === 'AND' ? results.every(Boolean) : results.some(Boolean); }
  function countConditions(group) { return group.children.reduce((count, child) => count + (child.type === 'condition' ? 1 : countConditions(child)), 0); }
  function removeNode(group, id) { const index = group.children.findIndex((child) => child.id === id); if (index !== -1) { group.children.splice(index,1); return true; } return group.children.some((child) => child.type === 'group' && removeNode(child,id)); }
  function csvValue(value) { const text = value === undefined || value === null ? '' : String(value); return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g,'""') + '"' : text; }

  function filterGroupComponent(group, app) {
    return {
      group,
      app,
      init() {
        this.$el.innerHTML = `
          <div class="group">
            <div class="group-head">
              <div style="display:flex;align-items:center;gap:10px;"><div class="op-toggle"><template x-for="op in ['AND','OR']" :key="op"><button type="button" :class="{active: group.op===op, or: group.op===op && op==='OR'}" @click="group.op=op; app.refresh()" x-text="op"></button></template></div><span style="font-size:11px;color:var(--muted);">match all conditions using</span></div>
              <div class="group-actions"><button type="button" class="btn small" @click="app.addCondition(group)">+ Condition</button><button type="button" class="btn small ghost" @click="app.addGroup(group)">+ Nested group</button><button type="button" class="btn danger small" x-show="group !== app.filterTree" @click="app.removeNode(app.filterTree, group.id); app.refresh()">✕ Remove group</button></div>
            </div>
            <div class="group-items">
              <div class="empty-hint" x-show="group.children.length===0">No conditions yet — showing all rows. Add a condition to start filtering.</div>
              <template x-for="(child,index) in group.children" :key="child.id">
                <div>
                  <div class="and-sep" x-show="index>0" x-text="group.op"></div>
                  <template x-if="child.type==='condition'"><div class="condition">
                    <select class="col-select" x-model="child.column" @change="app.normaliseCondition(child); app.refresh()"><template x-for="c in app.visibleColumns" :key="c"><option :value="c" x-text="c"></option></template></select>
                    <span class="type-tag" x-text="app.columnTypes[child.column] || 'text'"></span>
                    <select class="op-select" x-model="child.operator" @change="app.refresh()"><template x-for="op in app.operatorsFor(child)" :key="op[0]"><option :value="op[0]" x-text="op[1]"></option></template></select>
                    <template x-if="child.operator!=='empty' && child.operator!=='nempty'"><input class="val-input" :type="app.columnTypes[child.column]==='number'?'number':(app.columnTypes[child.column]==='date'?'date':'text')" placeholder="Value…" x-model="child.value" @input="app.refresh()"></template>
                    <template x-if="child.operator==='between'"><span style="display:flex;align-items:center;gap:8px;width:100%;"><span style="font-size:11px;color:var(--muted);">and</span><input class="val-input" :type="app.columnTypes[child.column]==='number'?'number':'date'" x-model="child.value2" @input="app.refresh()"></span></template>
                    <button type="button" class="btn danger small" @click="app.removeNode(app.filterTree,child.id); app.refresh()">✕</button>
                  </div></template>
                  <template x-if="child.type==='group'"><div x-data="filterGroup(child, app)"></div></template>
                </div>
              </template>
            </div>
          </div>`;
        Alpine.initTree(this.$el);
      }
    };
  }

  function csvViewer() {
    return {
      columns: [], rows: [], columnTypes: {}, visibleCols: new Set(), currentPage: 1, pageSize: 50,
      sortColumn: '', sortDirection: 'asc', resultSearch: '', columnSearch: '', fileName: '', dragging: false,
      toastMessage: '', filterTree: { id: nextId(), type: 'group', op: 'AND', children: [] },
      get hasData() { return this.fileName !== ''; },
      get visibleColumns() { return this.columns.filter((column) => this.visibleCols.has(column)); },
      get filteredColumns() { const term = this.columnSearch.toLowerCase(); return this.columns.filter((column) => column.toLowerCase().includes(term)); },
      get matchingRows() { return countConditions(this.filterTree) ? this.rows.filter((row) => evaluateGroup(this.filterTree,row,this.columnTypes)) : this.rows; },
      get searchedRows() { const term=this.resultSearch.trim().toLowerCase(); return term ? this.matchingRows.filter((row)=>this.visibleColumns.some((col)=>String(row[col]??'').toLowerCase().includes(term))) : this.matchingRows; },
      get sortedRows() { const source=this.searchedRows.slice(); if(!this.sortColumn) return source; const type=this.columnTypes[this.sortColumn]||'text', dir=this.sortDirection==='desc'?-1:1; return source.sort((a,b)=>{ const av=a[this.sortColumn],bv=b[this.sortColumn],ae=av==null||String(av).trim()==='',be=bv==null||String(bv).trim()===''; if(ae||be)return ae===be?0:(ae?1:-1); if(type==='number')return(Number(av)-Number(bv))*dir; if(type==='date')return(Date.parse(av)-Date.parse(bv))*dir; return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})*dir; }); },
      get maxPage() { return Math.max(1,Math.ceil(this.sortedRows.length/this.pageSize)); },
      get pagedRows() { if(this.currentPage>this.maxPage)this.currentPage=this.maxPage; return this.sortedRows.slice((this.currentPage-1)*this.pageSize,(this.currentPage)*this.pageSize); },
      get rowRange() { const total=this.sortedRows.length; if(!total)return 'No rows'; const start=(this.currentPage-1)*this.pageSize+1; return `Showing ${start}–${Math.min(start+this.pageSize-1,total)} of ${total.toLocaleString()}`; },
      handleDrop(event){ this.dragging=false; const file=event.dataTransfer.files[0]; if(file)this.handleFile(file); },
      handleFile(file){ if(!file)return; if(!file.name.toLowerCase().endsWith('.csv')&&file.type!=='text/csv')return this.toast("That doesn't look like a CSV file."); if(file.size>MAX_FILE_SIZE)return this.toast(`CSV file is too large (${(file.size/1048576).toFixed(2)} MB). Maximum allowed size is 10 MB.`); Papa.parse(file,{header:true,skipEmptyLines:true,dynamicTyping:false,complete:(results)=>{if(results.errors&&results.errors.length)return this.toast('Could not parse CSV: '+results.errors[0].message);this.columns=(results.meta.fields||[]).filter(Boolean);this.rows=results.data||[];this.columnTypes=detectTypes(this.columns,this.rows);this.visibleCols=new Set(this.columns.slice(0,8));this.filterTree={id:nextId(),type:'group',op:'AND',children:[]};this.currentPage=1;this.resultSearch='';this.columnSearch='';this.sortColumn='';this.sortDirection='asc';this.fileName=file.name;},error:(error)=>this.toast('Could not parse CSV: '+error.message)}); },
      clearData(){this.columns=[];this.rows=[];this.columnTypes={};this.visibleCols=new Set();this.filterTree={id:nextId(),type:'group',op:'AND',children:[]};this.fileName='';this.resultSearch='';this.columnSearch='';this.sortColumn='';this.currentPage=1;this.$refs.file.value='';},
      toggleColumn(column){const next=new Set(this.visibleCols);next.has(column)?next.delete(column):next.add(column);this.visibleCols=next;if(!next.has(this.sortColumn))this.sortColumn='';this.normaliseAllConditions(this.filterTree);},
      showAllColumns(){this.visibleCols=new Set(this.columns);}, hideAllColumns(){this.visibleCols=new Set();this.sortColumn='';}, resetColumns(){this.visibleCols=new Set(this.columns.slice(0,8));if(!this.visibleCols.has(this.sortColumn))this.sortColumn='';},
      addCondition(group){group.children.push({id:nextId(),type:'condition',column:this.visibleColumns[0]||this.columns[0]||'',operator:'contains',value:'',value2:''});}, addGroup(group){group.children.push({id:nextId(),type:'group',op:'AND',children:[]});},
      normaliseCondition(condition){const type=this.columnTypes[condition.column]||'text';if(!OPERATORS[type].some((operator)=>operator[0]===condition.operator))condition.operator=OPERATORS[type][0][0];}, normaliseAllConditions(group){group.children.forEach((child)=>child.type==='group'?this.normaliseAllConditions(child):this.normaliseCondition(child));}, operatorsFor(condition){return OPERATORS[this.columnTypes[condition.column]||'text'];}, removeNode(group,id){removeNode(group,id);}, refresh(){this.currentPage=1;}, isNumericOrDate(column){return this.columnTypes[column]==='number'||this.columnTypes[column]==='date';}, rowNumber(index){return(this.currentPage-1)*this.pageSize+index+1;},
      toast(message){this.toastMessage=message;clearTimeout(this._toastTimer);this._toastTimer=setTimeout(()=>{this.toastMessage='';},3200);},
      exportCsv(){const cols=this.visibleColumns;if(!cols.length)return this.toast('Select at least one visible column before exporting.');const csv=[cols,...this.sortedRows.map((row)=>cols.map((col)=>row[col]))].map((row)=>row.map(csvValue).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='filtered-data.csv';link.click();URL.revokeObjectURL(url);}
    };
  }

  document.addEventListener('alpine:init', () => {
    Alpine.data('csvViewer', csvViewer);
    Alpine.data('filterGroup', filterGroupComponent);
  });
})();
