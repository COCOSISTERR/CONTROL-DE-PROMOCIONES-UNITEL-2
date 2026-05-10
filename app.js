// ============================================================
// CONTROL SEMANAL UNITEL — app.js
// Supabase + Realtime. Reemplaza localStorage completamente.
// ============================================================

// ===== 1. CONFIGURACIÓN SUPABASE =====
// !! REEMPLAZA ESTOS DOS VALORES con los tuyos de Supabase !!
const SUPABASE_URL = 'https://cdfkwjdbwpjvxlkgehkm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNkZmt3amRid3Bqdnhsa2dlaGttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NDQxODcsImV4cCI6MjA5MzMyMDE4N30.VmNg_e5wNe7zAzEWn5i6jYZcUFjjL0ByO7stKOfKRKw';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== 2. ESTADO GLOBAL =====
let isLoggedIn = false;
let userName = '';
let userRole = null;  // 'operator' o 'admin'
let currentDay = 'monday';
let currentCalendarDate = new Date();
let weekData = {};          // { monday: { promotions: [] }, ... }
let calendarNotes = {};     // { 'YYYY-MM-DD': 'texto' }
let changeHistory = [];     // últimos cambios
let importedPromotions = [];
let editingPromotionId = null;
let realtimeChannel = null;
let operatorNotifications = []; // notificaciones en tiempo real para operador

const daysOfWeek = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const dayNames    = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
const dayShort    = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

const categoryLabels = {
    diario:'DIARIO', streaming:'STREAMING', radio:'RADIO', digital:'DIGITAL',
    mundial:'MUNDIAL', apagon:'APAGÓN',
    momento_simpson:'MOMENTO SIMPSON', id:'ID', masterchef:'MASTERCHEF',
    presentacion:'PRESENTACIÓN', despedida:'DESPEDIDA'
};

// ===== 3. INICIALIZACIÓN =====
window.addEventListener('load', async () => {
    daysOfWeek.forEach(d => { weekData[d] = { promotions: [] }; });

    const minWait = new Promise(r => setTimeout(r, 800));

    try {
        await Promise.all([
            db.from('promotions').select('id').limit(1),
            minWait
        ]);
    } catch (e) {
        console.error('Supabase connection error:', e);
        // Aunque falle, mostramos el login con mensaje de error
        // (puede que las credenciales sean válidas y el error sea temporal)
    } finally {
        // Siempre ocultar la pantalla de carga y mostrar el login
        document.getElementById('loadingScreen').style.display = 'none';
        document.getElementById('loginScreen').style.display = 'flex';
    }

    document.addEventListener('keypress', e => {
        if (e.key === 'Enter') {
            const active = document.activeElement.id;
            if (active === 'loginCode' || active === 'loginName') login();
        }
    });
});

// ===== 4. AUTH =====
async function login() {
    const nameInput = document.getElementById('loginName').value.trim();
    const code = document.getElementById('loginCode').value.trim();

    if (!nameInput) {
        const el = document.getElementById('loginName');
        el.style.borderColor = '#e74c3c'; el.focus();
        setTimeout(() => el.style.borderColor = '', 2000);
        return;
    }

    // Determinar rol según contraseña
    let role = null;
    if (code === '0000') {
        role = 'operator';
    } else if (code === '8888') {
        role = 'admin';
    } else {
        document.getElementById('loginError').textContent = '❌ Código incorrecto. Operador: 0000, Admin: 8888';
        document.getElementById('loginCode').value = '';
        setTimeout(() => document.getElementById('loginError').textContent = '', 4000);
        return;
    }

    userName = nameInput;
    userRole = role;
    isLoggedIn = true;

    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainContainer').style.display = 'block';

    // Mostrar rol en badge
    const roleLabel = role === 'admin' ? '👨‍💼 ADMINISTRADOR' : '👤 OPERADOR';
    document.getElementById('userBadge').textContent = `${roleLabel} • ${userName}`;
    
    const today = new Date();
    const dateStr = today.toLocaleDateString('es-ES', {weekday:'long',year:'numeric',month:'long',day:'numeric'});
    document.getElementById('currentDate').textContent = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);

    // Aplicar permisos según rol
    applyRolePermissions();

    await loadAllData();

    generateDayTabs();
    renderPromotions();
    attachSearchListeners();
    loadProgramImage();
    generateCalendar();
    updateStatistics();
    setupRealtime();
}

function applyRolePermissions() {
    const isOperator = userRole === 'operator';

    // Restaurar visibilidad de todo (por si venía de sesión anterior en la misma página)
    document.querySelectorAll('.tab-btn').forEach(btn => btn.style.display = '');
    ['btnAddPromo','btnImportDay','btnCopyPromo','btnDeleteWeek','btnDeleteDay',
     'btnImportWeekly','btnDeleteWeekFull'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
    });

    if (isOperator) {
        // Ocultar botones exclusivos de admin en tab Promociones
        ['btnAddPromo','btnImportDay','btnCopyPromo','btnDeleteWeek','btnDeleteDay'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        // Ocultar botones exclusivos de admin en tab Programación Semanal
        ['btnImportWeekly','btnDeleteWeekFull'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        // Mostrar botón de limpiar día para operadores
        const btnCleanDay = document.getElementById('btnCleanDay');
        if (btnCleanDay) btnCleanDay.style.display = '';
    }
}

function logout() {
    if (!confirm('¿Deseas cerrar sesión?')) return;
    isLoggedIn = false;
    if (realtimeChannel) db.removeChannel(realtimeChannel);
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('mainContainer').style.display = 'none';
    document.getElementById('loginCode').value = '';
    document.getElementById('loginName').value = '';
    document.getElementById('realtimeDot').className = '';
}

// ===== 5. SUPABASE DATA LOAD =====
async function loadAllData() {
    daysOfWeek.forEach(d => { weekData[d] = { promotions: [] }; });

    // Cargar promociones
    const { data: promos, error } = await db
        .from('promotions')
        .select('*')
        .order('created_at', { ascending: true });

    if (error) { console.error('Error cargando promociones:', error); return; }

    promos.forEach(p => {
        if (!weekData[p.day]) weekData[p.day] = { promotions: [] };
        weekData[p.day].promotions.push(mapDbToPromo(p));
    });

    // Cargar notas del calendario
    const { data: notes } = await db.from('calendar_notes').select('*');
    calendarNotes = {};
    if (notes) notes.forEach(n => { calendarNotes[n.date] = n.note; });

    // Cargar historial de cambios (últimos 50)
    const { data: history } = await db
        .from('change_history')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
    changeHistory = history ? history.map(h => ({
        type: h.type, action: h.action, user: h.user_name, date: h.created_at
    })) : [];
}

// Convierte fila de DB → objeto promo del app
function mapDbToPromo(row) {
    return {
        id: row.id,
        code: row.code,
        name: row.name,
        category: row.category,
        level: row.level,
        comments: row.comments || '',
        status: row.status,
        importedFromXls: row.imported_from_xls,
        createdBy: row.created_by,
        createdAt: row.created_at,
        lastModified: row.last_modified
    };
}

// Convierte promo del app → objeto para insertar en DB
function mapPromoToDb(promo, day) {
    return {
        id: promo.id,
        day: day,
        code: promo.code,
        name: promo.name,
        category: promo.category,
        level: promo.level,
        comments: promo.comments || '',
        status: promo.status || 'pending',
        imported_from_xls: promo.importedFromXls || false,
        created_by: promo.createdBy || userName,
        last_modified: new Date().toISOString()
    };
}

// ===== 6. REALTIME =====
function setupRealtime() {
    const dot = document.getElementById('realtimeDot');

    realtimeChannel = db.channel('control-semanal-global')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'promotions' },
            async (payload) => {
                await handleRealtimePromotion(payload);
            }
        )
        .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_notes' },
            async (payload) => {
                await handleRealtimeNote(payload);
            }
        )
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'change_history' },
            (payload) => {
                const h = payload.new;
                // Evitar duplicar cambios propios (ya los tenemos en memoria)
                changeHistory.unshift({ type: h.type, action: h.action, user: h.user_name, date: h.created_at });
                if (changeHistory.length > 50) changeHistory.pop();
                if (document.getElementById('tab-cambios').classList.contains('active')) renderChanges();
                if (document.getElementById('tab-progreso').classList.contains('active')) renderChangeHistory();
            }
        )
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'program_image' },
            (payload) => {
                if (payload.new && payload.new.image_data) {
                    showProgramImageFromData(payload.new.image_data);
                } else {
                    clearProgramImage();
                }
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                dot.className = 'connected';
                dot.title = '🟢 Conectado en tiempo real';
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                dot.className = 'disconnected';
                dot.title = '🔴 Sin conexión en tiempo real';
            }
        });
}

async function handleRealtimePromotion(payload) {
    const { eventType, new: newRow, old: oldRow } = payload;

    if (eventType === 'INSERT') {
        const day = newRow.day;
        if (!weekData[day]) weekData[day] = { promotions: [] };
        // Evitar duplicar si lo insertamos nosotros mismos
        if (!weekData[day].promotions.find(p => p.id === newRow.id)) {
            weekData[day].promotions.push(mapDbToPromo(newRow));
            // Notificación en tiempo real para cualquier usuario (operador o admin) sobre cambios de otros
            if (newRow.created_by !== userName) {
                showAlert(`✨ Promoción nueva agregada por ${newRow.created_by}: ${newRow.code}`, 'success');
            }
        }
    } else if (eventType === 'UPDATE') {
        const day = newRow.day;
        if (weekData[day]) {
            const idx = weekData[day].promotions.findIndex(p => p.id === newRow.id);
            if (idx !== -1) {
                const oldPromo = weekData[day].promotions[idx];
                weekData[day].promotions[idx] = mapDbToPromo(newRow);
                // Notificación en tiempo real para cualquier usuario sobre cambios de otros
                if (newRow.created_by !== userName) {
                    const changes = [];
                    if (oldPromo.status !== newRow.status) changes.push(`estado → ${newRow.status}`);
                    if (oldPromo.comments !== newRow.comments) changes.push(`comentarios actualizados`);
                    if (changes.length > 0) {
                        showAlert(`🔄 Cambio en ${newRow.code}: ${changes.join(', ')}`, 'warning');
                    }
                }
            }
        }
    } else if (eventType === 'DELETE') {
        const day = oldRow.day;
        if (weekData[day]) {
            weekData[day].promotions = weekData[day].promotions.filter(p => p.id !== oldRow.id);
            // Notificación en tiempo real para cualquier usuario sobre eliminaciones de otros
            if (oldRow.created_by !== userName) {
                showAlert(`🗑️ Promoción eliminada: ${oldRow.code}`, 'error');
            }
        }
    }

    renderPromotions();
    updateStatistics();
}

async function handleRealtimeNote(payload) {
    const { eventType, new: newRow, old: oldRow } = payload;
    if (eventType === 'DELETE') {
        delete calendarNotes[oldRow.date];
    } else {
        calendarNotes[newRow.date] = newRow.note;
    }
    if (document.getElementById('tab-calendario').classList.contains('active')) generateCalendar();
}

// ===== 8. TAB SWITCHING =====
function switchTab(tabName, btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + tabName).classList.add('active');
    if (tabName === 'calendario') generateCalendar();
    else if (tabName === 'cambios') renderChanges();
    else if (tabName === 'progreso') updateStatistics();
}

// ===== 9. DAY TABS =====
function generateDayTabs() {
    const container = document.getElementById('dayTabs');
    container.innerHTML = '';
    daysOfWeek.forEach((day, index) => {
        const btn = document.createElement('button');
        btn.className = 'day-tab' + (day === currentDay ? ' active' : '');
        btn.textContent = dayNames[index];
        btn.onclick = () => {
            currentDay = day;
            document.querySelectorAll('.day-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Resetear filtros
            document.getElementById('daySearchInput').value = '';
            document.getElementById('daySearchCategory').value = '';
            document.getElementById('btnFilterPending').dataset.active = 'false';
            document.getElementById('btnFilterPending').style.opacity = '0.7';
            
            document.getElementById('daySearchInput').placeholder = `Buscar en ${dayNames[index]}...`;
            renderPromotions();
        };
        container.appendChild(btn);
    });
}

// ===== 10. CATEGORY DETECTION =====
function detectCategoryFromDescription(description) {
    if (!description) return 'diario';
    const d = description.toUpperCase();
    if (d.includes('MASTER CHEF') || d.includes('MASTERCHEF')) return 'masterchef';
    if (d.includes('MUNDIAL')) return 'mundial';
    if (d.includes('APAGON') || d.includes('APAGÓN') || d.includes('ANALOGICO')) return 'apagon';
    if (d.includes('BUMPER')) return 'id';
    if (d.includes('STREAMING')) return 'streaming';
    if (d.includes('RADIO')) return 'radio';
    if (d.includes('DEPORTE') || d.includes('DEPORTES')) return 'deportes';
    if (d.includes('PRESENTACION') || d.includes('PRESENTACIÓN')) return 'presentacion';
    if (d.includes('DESPEDIDA')) return 'despedida';
    if (d.includes('DIGITAL')) return 'digital';
    if (d.includes('SIMPSON')) return 'momento_simpson';
    return 'diario';
}

// ===== 11. PROMOTION CRUD (con Supabase) =====
function populateAutocompleteCodes() {
    const codeSet = new Set(), nameSet = new Set();
    daysOfWeek.forEach(day => {
        (weekData[day]?.promotions || []).forEach(p => {
            if (p.code) codeSet.add(p.code.trim());
            if (p.name) nameSet.add(p.name.trim());
        });
    });
    const codeList = document.getElementById('promoCodeList');
    const nameList = document.getElementById('promoNameList');
    codeList.innerHTML = '';
    nameList.innerHTML = '';
    Array.from(codeSet).sort().forEach(v => { const o = document.createElement('option'); o.value = v; codeList.appendChild(o); });
    Array.from(nameSet).sort().forEach(v => { const o = document.createElement('option'); o.value = v; nameList.appendChild(o); });
}

function openAddPromotionModal() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden agregar promociones', 'error');
        return;
    }
    populateAutocompleteCodes();
    editingPromotionId = null;
    document.getElementById('promotionModalTitle').textContent = '➕ Agregar Promoción';
    ['promotionCode','promotionName','promotionComments'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('promotionCategory').value = '';
    document.getElementById('promotionLevel').value = 'generica';
    document.getElementById('promotionModal').classList.add('active');
}

async function savePromotion() {
    const code     = document.getElementById('promotionCode').value.trim();
    const name     = document.getElementById('promotionName').value.trim();
    const category = document.getElementById('promotionCategory').value;
    const level    = document.getElementById('promotionLevel').value;
    const comments = document.getElementById('promotionComments').value.trim();

    if (!code || !name || !category || !level) {
        showAlert('❌ Completa código, nombre, categoría y nivel', 'error'); return;
    }

    const btn = document.querySelector('#promotionModal .success');
    btn.disabled = true;

    try {
        if (editingPromotionId) {
            const { error } = await db.from('promotions').update({
                code, name, category, level, comments, last_modified: new Date().toISOString()
            }).eq('id', editingPromotionId);
            if (error) throw error;
            // update local cache
            const promo = weekData[currentDay].promotions.find(p => p.id === editingPromotionId);
            if (promo) Object.assign(promo, { code, name, category, level, comments, lastModified: new Date() });
            await trackChange('modified', `Promoción actualizada: ${code} - ${name}`);
            showAlert('✅ Promoción actualizada', 'success');
        } else {
            const newId = 'promo_' + Date.now() + '_' + Math.random().toString(36).substr(2,9);
            const row = { id: newId, day: currentDay, code, name, category, level, comments,
                status: 'pending', imported_from_xls: false, created_by: userName,
                created_at: new Date().toISOString(), last_modified: new Date().toISOString() };
            const { error } = await db.from('promotions').insert(row);
            if (error) throw error;
            // update local cache (realtime will also fire but we avoid flicker)
            if (!weekData[currentDay]) weekData[currentDay] = { promotions: [] };
            weekData[currentDay].promotions.push(mapDbToPromo(row));
            await trackChange('new', `Promoción agregada: ${code} - ${name}`);
            showAlert('✅ Promoción agregada', 'success');
        }
        renderPromotions();
        updateStatistics();
        closeModal('promotionModal');
    } catch (e) {
        showAlert('❌ Error guardando: ' + e.message, 'error');
        console.error(e);
    } finally {
        btn.disabled = false;
    }
}

function editPromotion(promotionId) {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden editar promociones', 'error');
        return;
    }
    const promo = weekData[currentDay]?.promotions.find(p => p.id === promotionId);
    if (!promo) return;
    editingPromotionId = promotionId;
    document.getElementById('promotionModalTitle').textContent = '✏️ Editar Promoción';
    document.getElementById('promotionCode').value = promo.code || '';
    document.getElementById('promotionName').value = promo.name || '';
    document.getElementById('promotionCategory').value = promo.category || '';
    document.getElementById('promotionLevel').value = promo.level || '';
    document.getElementById('promotionComments').value = promo.comments || '';
    document.getElementById('promotionModal').classList.add('active');
}

async function deletePromotion(promotionId) {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden eliminar promociones', 'error');
        return;
    }
    if (!confirm('¿Eliminar esta promoción?')) return;
    const { error } = await db.from('promotions').delete().eq('id', promotionId);
    if (error) { showAlert('❌ Error eliminando: ' + error.message, 'error'); return; }
    weekData[currentDay].promotions = weekData[currentDay].promotions.filter(p => p.id !== promotionId);
    await trackChange('deleted', 'Promoción eliminada');
    showAlert('✅ Promoción eliminada', 'success');
    renderPromotions(); updateStatistics();
}

async function markPromotionStatus(promotionId, status) {
    const promo = weekData[currentDay]?.promotions.find(p => p.id === promotionId);
    if (!promo) return;

    let updatedComments = promo.comments;
    
    if (status === 'ok') {
        updatedComments = '';
    }

    const { error } = await db.from('promotions')
        .update({ status, comments: updatedComments, last_modified: new Date().toISOString() })
        .eq('id', promotionId);
    if (error) { showAlert('❌ Error: ' + error.message, 'error'); return; }
    
    promo.status = status;
    promo.comments = updatedComments;
    promo.lastModified = new Date();
    await trackChange('modified', `Promoción marcada como ${status === 'ok' ? 'OK ✅' : 'ERROR ❌'}`);
    showAlert(`✅ Marcada como ${status === 'ok' ? 'OK ✅' : 'ERROR ❌'}`, 'success');
    renderPromotions(); updateStatistics();
}

// ===== LIMPIAR PROMOCIONES =====
async function cleanDayPromotions() {
    if (!isLoggedIn) {
        showAlert('⛔ Debes estar logueado', 'error');
        return;
    }
    const promos = weekData[currentDay]?.promotions || [];
    const dayLabel = dayNames[daysOfWeek.indexOf(currentDay)];

    if (promos.length === 0) {
        showAlert(`⚠️ No hay promociones en ${dayLabel}`, 'warning');
        return;
    }

    if (!confirm(`¿Poner todas las promociones del ${dayLabel} en PENDIENTES?`)) return;

    // Actualizar todas a estado 'pending'
    const promoIds = promos.map(p => p.id);
    const { error } = await db.from('promotions')
        .update({ status: 'pending', last_modified: new Date().toISOString() })
        .in('id', promoIds);
    
    if (error) { showAlert('❌ Error: ' + error.message, 'error'); return; }

    promos.forEach(p => { p.status = 'pending'; });
    await trackChange('modified', `Limpiado: todas las promociones del ${dayLabel} en PENDIENTES`);
    showAlert(`✅ Promociones del ${dayLabel} limpias (PENDIENTES)`, 'success');
    renderPromotions();
    updateStatistics();
}

async function cleanWeekPromotions() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden limpiar', 'error');
        return;
    }
    const total = daysOfWeek.reduce((sum, d) => sum + (weekData[d]?.promotions?.length || 0), 0);

    if (total === 0) {
        showAlert('⚠️ No hay promociones cargadas', 'warning');
        return;
    }

    if (!confirm(`¿Poner TODAS las promociones de la semana (${total}) en PENDIENTES?`)) return;

    // Obtener todos los IDs de la semana
    const allPromoIds = [];
    daysOfWeek.forEach(d => {
        weekData[d]?.promotions?.forEach(p => {
            allPromoIds.push(p.id);
        });
    });

    const { error } = await db.from('promotions')
        .update({ status: 'pending', last_modified: new Date().toISOString() })
        .in('id', allPromoIds);
    
    if (error) { showAlert('❌ Error: ' + error.message, 'error'); return; }

    daysOfWeek.forEach(d => {
        weekData[d]?.promotions?.forEach(p => { p.status = 'pending'; });
    });

    await trackChange('modified', `Limpiada la semana: ${total} promociones en PENDIENTES`);
    showAlert(`✅ Semana completa limpia (${total} PENDIENTES)`, 'success');
    renderPromotions();
    updateStatistics();
}

// ===== 12. RENDER PROMOTIONS =====
function renderPromotions() {
    const container = document.getElementById('promotionsContainer');
    container.innerHTML = '';

    const promos = weekData[currentDay]?.promotions || [];
    if (promos.length === 0) {
        const msg = document.createElement('p');
        msg.style.cssText = 'text-align:center;color:#999;grid-column:1/-1;padding:40px;';
        msg.textContent = '📭 No hay promociones para este día.';
        container.appendChild(msg); return;
    }

    const searchText = (document.getElementById('daySearchInput')?.value || '').toLowerCase();
    const catFilter = document.getElementById('daySearchCategory')?.value || '';
    const filterPending = document.getElementById('btnFilterPending')?.dataset.active === 'true';

    // Determinar si es filtro de locales o categoría
    const isLocalFilter = catFilter.startsWith('local_');
    const levelFilter = isLocalFilter ? catFilter : '';

    promos.forEach(promo => {
        // Aplicar filtros
        const alltext = (promo.name+' '+promo.code+' '+promo.comments+' '+promo.category+' '+promo.level).toLowerCase();
        if (searchText && !alltext.includes(searchText)) return;
        
        // Filtro de categoría o nivel
        if (isLocalFilter) {
            // Filtro por nivel de local
            if (levelFilter && promo.level !== levelFilter) return;
        } else if (catFilter) {
            // Filtro por categoría
            if (promo.category !== catFilter) return;
        }
        
        if (filterPending && promo.status !== 'pending') return;

        const card = document.createElement('div');
        card.className = 'promotion-card';

        // Colores según estado
        let bgColor = 'linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)';
        let borderColor = '#dbe5f0';
        if (promo.status === 'ok') {
            bgColor = 'linear-gradient(180deg, #f0fff4 0%, #e6f9f0 100%)';
            borderColor = '#a8e6d9';
        } else if (promo.status === 'error') {
            bgColor = 'linear-gradient(180deg, #fff5f5 0%, #ffe6e6 100%)';
            borderColor = '#ffb3b3';
        }
        card.style.cssText = `background:${bgColor};border-color:${borderColor};`;

        const statusBadge = promo.status === 'ok'
            ? '<span class="badge ok">✅ OK</span>'
            : promo.status === 'error' ? '<span class="badge error">❌ ERROR</span>'
            : '<span class="badge pending">⏳ PENDIENTE</span>';

        const xlsTag = promo.importedFromXls
            ? '<span style="background:#f0e6ff;color:#7b2ff7;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:700;">📥 XLS</span>' : '';

        // Visualización compacta: código - nombre en 1-2 líneas
        const titleText = promo.code ? `${promo.code}` : 'SIN CÓDIGO';
        const nameText = promo.name || '';
        
        let html = `
            <div class="promotion-header">
                <div class="promotion-title-compact">${titleText}</div>
                <div style="display:flex;gap:6px;align-items:center;">${xlsTag}${statusBadge}</div>
            </div>
            <div class="promotion-name-line">${nameText}</div>
            <div class="promotion-meta">
                <span>📁 ${categoryLabels[promo.category] || promo.category || '-'}</span>
                ${(userRole === 'operator' && (!promo.level || promo.level === 'generica')) ? '' : `<span>📍 ${promo.level === 'local_scz' ? 'SC' : promo.level === 'local_lp' ? 'LP' : promo.level === 'local_ch' ? 'CH' : promo.level || '-'}</span>`}
                ${promo.createdBy ? `<span>Injestado por: ${promo.createdBy}</span>` : ''}
            </div>`;
        
        if (promo.comments) {
            html += `<div class="promotion-comment">${promo.comments}</div>`;
        }

        // Botones según rol
        let actionButtons = '';
        if (userRole === 'admin') {
            actionButtons = `
                <button onclick="editPromotion('${promo.id}')" id="btnEditPromo">✏️ Editar</button>
                <button onclick="deletePromotion('${promo.id}')" id="btnDeletePromo" class="danger">🗑️ Eliminar</button>
            `;
        }

        // Botones comunes (todos pueden marcar OK/ERROR)
        actionButtons += `
            <button onclick="markPromotionStatus('${promo.id}','ok')" class="success">✅ OK</button>
            <button onclick="openErrorCommentModal('${promo.id}')" class="danger">❌ ERROR</button>
        `;

        html += `<div class="promotion-actions">${actionButtons}</div>`;
        
        card.innerHTML = html;
        container.appendChild(card);
    });
}

function openErrorCommentModal(promotionId) {
    const promo = weekData[currentDay]?.promotions.find(p => p.id === promotionId);
    if (!promo) return;

    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.id = 'errorCommentModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">❌ Reporte de Error</div>
            <div style="margin-bottom:15px;">
                <strong>Promoción:</strong> ${promo.code} - ${promo.name}
            </div>
            <div style="margin-bottom:10px;color:#e74c3c;font-weight:600;">⚠️ El comentario es obligatorio</div>
            <textarea id="errorCommentText" placeholder="¿Cuál es el error en esta promoción?" style="width:100%;min-height:100px;padding:10px;border:2px solid #e0e6ed;border-radius:8px;font-family:inherit;"></textarea>
            <div class="modal-actions">
                <button onclick="document.getElementById('errorCommentModal').remove()">Cancelar</button>
                <button onclick="confirmErrorComment('${promotionId}')" class="danger">✅ Confirmar ERROR</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

async function confirmErrorComment(promotionId) {
    const comment = document.getElementById('errorCommentText').value.trim();
    const promo = weekData[currentDay]?.promotions.find(p => p.id === promotionId);
    if (!promo) return;

    // Validar que el comentario no esté vacío
    if (!comment) {
        showAlert('❌ Debes escribir un comentario explicando el error', 'error');
        document.getElementById('errorCommentText').focus();
        document.getElementById('errorCommentText').style.borderColor = '#e74c3c';
        return;
    }

    // Actualizar comentarios
    const newComments = promo.comments ? promo.comments + ' | ERROR: ' + comment : 'ERROR: ' + comment;
    
    const { error } = await db.from('promotions')
        .update({ status: 'error', comments: newComments, last_modified: new Date().toISOString() })
        .eq('id', promotionId);
    
    if (error) { 
        showAlert('❌ Error: ' + error.message, 'error'); 
        return; 
    }

    promo.status = 'error';
    promo.comments = newComments;
    promo.lastModified = new Date();
    
    await trackChange('modified', `Promoción marcada como ERROR: ${promo.code} - ${promo.name}`);
    showAlert('✅ Marcada como ERROR ❌', 'success');
    document.getElementById('errorCommentModal').remove();
    renderPromotions(); 
    updateStatistics();
}

function attachSearchListeners() {
    ['daySearchInput','daySearchCategory'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.removeEventListener('input', renderPromotions); el.removeEventListener('change', renderPromotions);
            el.addEventListener('input', renderPromotions); el.addEventListener('change', renderPromotions); }
    });
}

function toggleFilterPending(btn) {
    const isActive = btn.dataset.active === 'true';
    btn.dataset.active = !isActive;
    btn.style.opacity = !isActive ? '1' : '0.7';
    renderPromotions();
}

// ===== 13. XLS IMPORT =====
function detectDayFromFilename(filename) {
    const n = filename.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    if (n.includes('LUNES')) return 'monday';
    if (n.includes('MARTES')) return 'tuesday';
    if (n.includes('MIERCOLES')) return 'wednesday';
    if (n.includes('JUEVES')) return 'thursday';
    if (n.includes('VIERNES')) return 'friday';
    if (n.includes('SABADO')) return 'saturday';
    if (n.includes('DOMINGO')) return 'sunday';
    return null;
}

function detectDayFromDate(dateValue) {
    if (!dateValue) return null;
    let d = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (isNaN(d.getTime())) return null;
    const map = [null,'monday','tuesday','wednesday','thursday','friday','saturday'];
    return map[d.getDay()] || 'sunday';
}

function openImportXlsModal() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden importar', 'error');
        return;
    }
    importedPromotions = [];
    document.getElementById('importStep1').style.display = 'block';
    document.getElementById('importStep2').style.display = 'none';
    document.getElementById('importConfirmBtn').style.display = 'none';
    document.getElementById('importFileInput').value = '';
    document.getElementById('importPreviewBody').innerHTML = '';
    document.getElementById('importWarning').style.display = 'none';
    const zone = document.getElementById('importDropZone');
    zone.ondragover = e => { e.preventDefault(); zone.classList.add('drag-over'); };
    zone.ondragleave = () => zone.classList.remove('drag-over');
    zone.ondrop = e => { e.preventDefault(); zone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) processImportFile(e.dataTransfer.files[0]); };
    document.getElementById('importXlsModal').classList.add('active');
}

function handleImportFile(e) { if (e.target.files[0]) processImportFile(e.target.files[0]); }

function processImportFile(file) {
    if (!file.name.match(/\.(xls|xlsx)$/i)) { showAlert('❌ Solo .xls o .xlsx', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const wb = XLSX.read(new Uint8Array(e.target.result), {type:'array', cellDates:true});
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, defval:null, raw:false});
            parseXlsPromotions(rows, file.name);
        } catch(err) { showAlert('❌ Error leyendo archivo: ' + err.message, 'error'); }
    };
    reader.readAsArrayBuffer(file);
}

function parseXlsPromotions(rows, filename) {
    let detectedDay = detectDayFromFilename(filename);
    if (!detectedDay && rows[0]) detectedDay = detectDayFromDate(rows[0][7]);

    const seenCodes = new Set(), promos = [];
    for (const row of rows) {
        if (!row || row.length < 8) continue;
        if ((row[3]||'').toString().trim().toLowerCase() !== 'promocion') continue;
        const cod = (row[4]||'').toString().trim();
        const desc = (row[7]||'').toString().trim();
        if (!cod || !desc || seenCodes.has(cod)) continue;
        seenCodes.add(cod);
        const cleanDesc = desc.replace(/^[*"z.\s]+/,'').trim();
        promos.push({ cod, desc: cleanDesc||desc, category: detectCategoryFromDescription(cleanDesc||desc) });
    }

    if (promos.length === 0) { showAlert('⚠️ No se encontraron promociones en el archivo', 'warning'); return; }
    importedPromotions = promos;

    document.getElementById('importStep1').style.display = 'none';
    document.getElementById('importStep2').style.display = 'block';
    document.getElementById('importConfirmBtn').style.display = 'inline-block';
    document.getElementById('importSummary').innerHTML = `📋 <strong>${promos.length} promociones únicas</strong> encontradas en <em>${filename}</em>.`;
    if (detectedDay) {
        document.getElementById('importTargetDay').value = detectedDay;
        document.getElementById('importSummary').innerHTML += `<br>📅 Día detectado: <strong>${dayNames[daysOfWeek.indexOf(detectedDay)]}</strong>`;
    }

    const tbody = document.getElementById('importPreviewBody');
    tbody.innerHTML = '';
    promos.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><strong>${p.cod}</strong></td><td>${p.desc}</td><td><span class="category-badge">${categoryLabels[p.category]||p.category}</span></td><td>GENÉRICA</td>`;
        tbody.appendChild(tr);
    });

    const day = document.getElementById('importTargetDay').value;
    const existing = weekData[day]?.promotions || [];
    if (existing.length > 0) {
        document.getElementById('importWarning').style.display = 'block';
        document.getElementById('importWarning').innerHTML = `⚠️ Ese día ya tiene <strong>${existing.length} promociones</strong>.`;
    }
    document.getElementById('importTargetDay').onchange = function() {
        const ex = weekData[this.value]?.promotions || [];
        const w = document.getElementById('importWarning');
        if (ex.length > 0) { w.style.display='block'; w.innerHTML=`⚠️ Ese día ya tiene <strong>${ex.length} promociones</strong>.`; }
        else w.style.display='none';
    };
}

async function executeImport() {
    if (!importedPromotions.length) { showAlert('❌ Sin promociones para importar', 'error'); return; }
    const targetDay = document.getElementById('importTargetDay').value;
    const conflictMode = document.getElementById('importConflictMode').value;
    const dayLabel = dayNames[daysOfWeek.indexOf(targetDay)];
    const btn = document.getElementById('importConfirmBtn');
    btn.disabled = true;

    try {
        if (conflictMode === 'replace') {
            await db.from('promotions').delete().eq('day', targetDay);
            if (!weekData[targetDay]) weekData[targetDay] = { promotions: [] };
            weekData[targetDay].promotions = [];
        }

        const existingCodes = new Set((weekData[targetDay]?.promotions || []).map(p => (p.code||'').toLowerCase()));
        const toInsert = [];

        importedPromotions.forEach(p => {
            if (conflictMode === 'skip_duplicates' && existingCodes.has(p.cod.toLowerCase())) return;
            const id = 'promo_' + Date.now() + '_' + Math.random().toString(36).substr(2,9);
            toInsert.push({ id, day: targetDay, code: p.cod, name: p.desc, category: p.category,
                level: 'generica', comments: '', status: 'pending', imported_from_xls: true,
                created_by: userName, created_at: new Date().toISOString(), last_modified: new Date().toISOString() });
        });

        if (toInsert.length > 0) {
            const { error } = await db.from('promotions').insert(toInsert);
            if (error) throw error;
            if (!weekData[targetDay]) weekData[targetDay] = { promotions: [] };
            toInsert.forEach(r => weekData[targetDay].promotions.push(mapDbToPromo(r)));
        }

        const skipped = importedPromotions.length - toInsert.length;
        await trackChange('new', `Importación XLS: ${toInsert.length} promociones a ${dayLabel}`);
        let msg = `✅ ${toInsert.length} promoción(es) importada(s) a ${dayLabel}`;
        if (skipped > 0) msg += ` (${skipped} duplicadas omitidas)`;
        showAlert(msg, 'success');

        closeModal('importXlsModal');
        currentDay = targetDay;
        generateDayTabs();
        renderPromotions();
        updateStatistics();
    } catch(e) {
        showAlert('❌ Error importando: ' + e.message, 'error');
        console.error(e);
    } finally {
        btn.disabled = false;
    }
}

// ===== 14. COPY PROMOTIONS =====
function openCopyPromotionsModal() {
    document.getElementById('copySourceDay').value = currentDay;
    const nextIdx = (daysOfWeek.indexOf(currentDay)+1) % 7;
    document.getElementById('copyTargetDay').value = daysOfWeek[nextIdx];
    document.querySelector('input[name="copyMode"][value="all"]').checked = true;
    document.getElementById('singlePromoSelect').style.display = 'none';
    updateCopySourcePreview();
    document.getElementById('copyPromotionsModal').classList.add('active');
}

function updateCopySourcePreview() {
    const sourceDay = document.getElementById('copySourceDay').value;
    const copyMode = document.querySelector('input[name="copyMode"]:checked').value;
    const singleDiv = document.getElementById('singlePromoSelect');
    const promoSelect = document.getElementById('copySinglePromo');
    const preview = document.getElementById('copyPreview');

    if (copyMode === 'one') {
        singleDiv.style.display = 'block';
        const currentSource = promoSelect.dataset.loadedFor;
        if (currentSource !== sourceDay) {
            promoSelect.innerHTML = '<option value="">- Seleccionar -</option>';
            (weekData[sourceDay]?.promotions || []).forEach((p, i) => {
                const o = document.createElement('option');
                o.value = i;
                o.textContent = `${p.code||'Sin código'} - ${p.name||'Sin nombre'}`;
                promoSelect.appendChild(o);
            });
            promoSelect.dataset.loadedFor = sourceDay;
        }
    } else { singleDiv.style.display = 'none'; }

    const promos = weekData[sourceDay]?.promotions || [];
    const sourceDayName = dayNames[daysOfWeek.indexOf(sourceDay)];
    if (!promos.length) { preview.innerHTML = `<span style="color:#999;">📭 No hay promociones en ${sourceDayName}.</span>`; return; }

    let toCopy = [];
    if (copyMode === 'all') {
        toCopy = promos;
    } else {
        const idx = promoSelect.value;
        if (idx === '') { preview.innerHTML = `<span style="color:#999;">🔽 Selecciona una promoción.</span>`; return; }
        const p = promos[parseInt(idx)];
        if (p) toCopy = [p];
    }

    let html = '<strong>Promociones a copiar:</strong><br>';
    toCopy.forEach(p => { html += `• <strong>${p.code||'-'}</strong> ${p.name||''}<br>`; });
    preview.innerHTML = html;
}

async function executeCopyPromotions() {
    const sourceDay = document.getElementById('copySourceDay').value;
    const targetDay = document.getElementById('copyTargetDay').value;
    const copyMode = document.querySelector('input[name="copyMode"]:checked').value;

    if (sourceDay === targetDay) { showAlert('❌ Origen y destino no pueden ser el mismo', 'error'); return; }

    let toCopy = [];
    if (copyMode === 'one') {
        const idx = parseInt(document.getElementById('copySinglePromo').value);
        if (isNaN(idx)) { showAlert('❌ Selecciona una promoción', 'error'); return; }
        toCopy = [weekData[sourceDay].promotions[idx]];
    } else {
        toCopy = weekData[sourceDay]?.promotions || [];
        if (!toCopy.length) { showAlert('❌ No hay promociones en el día origen', 'error'); return; }
    }

    const rows = toCopy.map(p => ({
        id: 'promo_' + Date.now() + '_' + Math.random().toString(36).substr(2,9),
        day: targetDay, code: p.code, name: p.name, category: p.category, level: p.level,
        comments: p.comments||'', status: 'pending', imported_from_xls: p.importedFromXls||false,
        created_by: userName, created_at: new Date().toISOString(), last_modified: new Date().toISOString()
    }));

    const { error } = await db.from('promotions').insert(rows);
    if (error) { showAlert('❌ Error copiando: ' + error.message, 'error'); return; }
    if (!weekData[targetDay]) weekData[targetDay] = { promotions: [] };
    rows.forEach(r => weekData[targetDay].promotions.push(mapDbToPromo(r)));

    const targetName = dayNames[daysOfWeek.indexOf(targetDay)];
    await trackChange('new', `Copiado ${rows.length} promociones a ${targetName}`);
    showAlert(`✅ ${rows.length} promoción(es) copiada(s) a ${targetName}`, 'success');
    closeModal('copyPromotionsModal');
    if (currentDay === targetDay) { renderPromotions(); updateStatistics(); }
}

// ===== 15. CALENDAR NOTES =====
function generateCalendar() {
    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = '';
    const year = currentCalendarDate.getFullYear(), month = currentCalendarDate.getMonth();
    document.getElementById('calendarTitle').textContent = currentCalendarDate.toLocaleString('es-ES', {month:'long', year:'numeric'});
    dayShort.forEach(d => { const div = document.createElement('div'); div.className='calendar-header'; div.textContent=d; grid.appendChild(div); });
    const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month+1, 0).getDate();
    for (let i = 0; i < firstDay; i++) grid.appendChild(document.createElement('div'));
    const todayStr = new Date().toISOString().split('T')[0];
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const div = document.createElement('div');
        div.className = 'calendar-day' + (dateStr === todayStr ? ' today' : '');
        div.innerHTML = `<div class="calendar-day-number">${d}</div>`;
        if (calendarNotes[dateStr]) div.innerHTML += `<div class="calendar-note-badge">📝</div>`;
        div.onclick = () => showCalendarTasks(dateStr);
        grid.appendChild(div);
    }
}

function showCalendarTasks(dateStr) {
    const taskDiv = document.getElementById('calendarTasks');
    const note = calendarNotes[dateStr] || '';
    const changes = changeHistory.filter(c => (c.date||'').toString().startsWith(dateStr));
    const formattedDate = new Date(dateStr+'T12:00:00').toLocaleDateString('es-ES', {weekday:'long',year:'numeric',month:'long',day:'numeric'});
    let html = `<h4>📅 ${formattedDate}</h4>
        <div class="calendar-note-section">
            <label>📝 Nota:</label>
            <textarea id="calendarNoteTextarea" data-date="${dateStr}" placeholder="Escribe tu nota...">${note}</textarea>
            <div class="calendar-note-actions">
                <button onclick="saveCalendarNote('${dateStr}')" class="success">💾 Guardar</button>
                ${note ? `<button onclick="deleteCalendarNote('${dateStr}')" class="warning">🗑️ Eliminar</button>` : ''}
            </div>
        </div>
        <h5>📋 Cambios registrados:</h5>`;
    if (!changes.length) html += '<p style="color:#999;">Sin cambios para esta fecha.</p>';
    else changes.forEach(c => {
        html += `<div class="change-item ${c.type}">
            <strong>${c.type==='new'?'✨ Nuevo':c.type==='modified'?'✏️ Modificado':'❌ Eliminado'}</strong><br>
            <small>${c.action}</small><br>
            <small style="opacity:0.7;">Por: ${c.user} | ${new Date(c.date).toLocaleString('es-ES')}</small>
        </div>`;
    });
    taskDiv.innerHTML = html;
}

async function saveCalendarNote(dateStr) {
    const textarea = document.getElementById('calendarNoteTextarea');
    if (!textarea) return;
    const note = textarea.value.trim();
    if (!note) { await deleteCalendarNote(dateStr); return; }

    const { error } = await db.from('calendar_notes').upsert(
        { date: dateStr, note, updated_by: userName, updated_at: new Date().toISOString() },
        { onConflict: 'date' }
    );
    if (error) { showAlert('❌ Error guardando nota: ' + error.message, 'error'); return; }
    calendarNotes[dateStr] = note;
    showAlert('✅ Nota guardada', 'success');
    generateCalendar(); showCalendarTasks(dateStr);
}

async function deleteCalendarNote(dateStr) {
    if (!confirm('¿Eliminar nota?')) return;
    const { error } = await db.from('calendar_notes').delete().eq('date', dateStr);
    if (error) { showAlert('❌ Error: ' + error.message, 'error'); return; }
    delete calendarNotes[dateStr];
    showAlert('✅ Nota eliminada', 'success');
    generateCalendar(); showCalendarTasks(dateStr);
}

function previousMonth() { currentCalendarDate.setMonth(currentCalendarDate.getMonth()-1); generateCalendar(); }
function nextMonth()     { currentCalendarDate.setMonth(currentCalendarDate.getMonth()+1); generateCalendar(); }

// ===== 16. PROGRAM IMAGE =====
async function handleProgramImageUpload(event) {
    const file = event.target.files[0];
    if (!file || !file.type.startsWith('image/')) { showAlert('❌ Selecciona una imagen', 'error'); return; }
    const reader = new FileReader();
    reader.onload = async e => {
        const imageData = e.target.result;
        const { error } = await db.from('program_image').update({ image_data: imageData, updated_by: userName, updated_at: new Date().toISOString() }).eq('id', 1);
        if (error) { showAlert('❌ Error guardando imagen: ' + error.message, 'error'); return; }
        showProgramImageFromData(imageData);
        showAlert('✅ Imagen actualizada para todos los usuarios', 'success');
    };
    reader.readAsDataURL(file);
}

function showProgramImageFromData(data) {
    document.getElementById('programImageUpload').style.display = 'none';
    document.getElementById('programImageDisplay').style.display = 'flex';
    document.getElementById('programImage').src = data;
}

function clearProgramImage() {
    document.getElementById('programImageUpload').style.display = 'flex';
    document.getElementById('programImageDisplay').style.display = 'none';
    document.getElementById('programImage').src = '';
}

async function removeProgramImage() {
    if (!confirm('¿Eliminar la imagen de programación?')) return;
    const { error } = await db.from('program_image').update({ image_data: null, updated_by: userName }).eq('id', 1);
    if (error) { showAlert('❌ Error: ' + error.message, 'error'); return; }
    clearProgramImage();
    showAlert('✅ Imagen eliminada', 'success');
}

async function loadProgramImage() {
    const { data } = await db.from('program_image').select('image_data').eq('id', 1).single();
    if (data?.image_data) showProgramImageFromData(data.image_data);
}

// ===== 17. CHANGE HISTORY =====
async function trackChange(type, action) {
    const row = { type, action, user_name: userName, created_at: new Date().toISOString() };
    await db.from('change_history').insert(row);
    changeHistory.unshift({ type, action, user: userName, date: row.created_at });
    if (changeHistory.length > 50) changeHistory.pop();
}

function renderChanges() {
    const container = document.getElementById('changesContainer');
    if (!changeHistory.length) { container.innerHTML = '<p style="text-align:center;color:#999;">📭 Sin cambios.</p>'; return; }
    container.innerHTML = '';
    changeHistory.slice(0,20).forEach(c => {
        const item = document.createElement('div');
        item.className = `change-item ${c.type}`;
        item.innerHTML = `<strong>${c.type==='new'?'✨ Nuevo':c.type==='modified'?'✏️ Modificado':'❌ Eliminado'}</strong><br>
            <small>${c.action}</small><br>
            <small style="opacity:0.7;">Por: ${c.user} | ${new Date(c.date).toLocaleString('es-ES')}</small>`;
        container.appendChild(item);
    });
}

function renderChangeHistory() {
    const container = document.getElementById('changeHistoryContainer');
    if (!changeHistory.length) { container.innerHTML = '<p style="text-align:center;color:#999;">📭 Sin cambios.</p>'; return; }
    container.innerHTML = '';
    changeHistory.slice(0,20).forEach(c => {
        const item = document.createElement('div');
        item.className = `change-item ${c.type}`;
        item.innerHTML = `<strong>${c.type==='new'?'✨ Nuevo':c.type==='modified'?'✏️ Modificado':'❌ Eliminado'}</strong><br>
            <small>${c.action}</small><br><small style="opacity:0.7;">Por: ${c.user}</small>`;
        container.appendChild(item);
    });
}

// ===== 18. STATISTICS =====
function updateStatistics() {
    let total=0, ok=0, error=0;
    daysOfWeek.forEach(day => {
        (weekData[day]?.promotions||[]).forEach(p => { total++; if(p.status==='ok') ok++; if(p.status==='error') error++; });
    });
    const pct = total > 0 ? Math.round((ok/total)*100) : 0;
    document.getElementById('statTotalPromotions').textContent = total;
    document.getElementById('statOkPromotions').textContent = ok;
    document.getElementById('statErrorPromotions').textContent = error;
    document.getElementById('statCompliancePercent').textContent = pct+'%';
    renderProgressTable(); renderChangeHistory();
}

function renderProgressTable() {
    const tbody = document.getElementById('progressBody');
    tbody.innerHTML = '';
    daysOfWeek.forEach((day, i) => {
        const promos = weekData[day]?.promotions || [];
        const reviewed = promos.filter(p => p.status !== 'pending').length;
        const pct = promos.length > 0 ? Math.round((reviewed/promos.length)*100) : 0;
        const row = tbody.insertRow();
        row.innerHTML = `<td><strong>${dayNames[i]}</strong></td><td>${promos.length}</td><td>${reviewed}</td><td>${promos.length-reviewed}</td><td><strong>${pct}%</strong></td>`;
    });
}

// ===== 19. EXCEL EXPORT =====
async function exportToExcel() {
    const dayIdx = daysOfWeek.indexOf(currentDay);
    const dayName = dayNames[dayIdx];
    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES');
    const timeStr = now.toLocaleTimeString('es-ES');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = userName; workbook.created = now;

    // Hoja Resumen
    const wsR = workbook.addWorksheet('Resumen');
    wsR.columns = [{width:5},{width:30},{width:30},{width:20}];
    wsR.mergeCells('B2:E2');
    const titleCell = wsR.getCell('B2');
    titleCell.value = '📺 CONTROL SEMANAL - UNITEL';
    titleCell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3C72'}};
    titleCell.font = {bold:true,size:16,color:{argb:'FFFFFFFF'},name:'Calibri'};
    titleCell.alignment = {horizontal:'center',vertical:'middle'};
    wsR.getRow(2).height = 35;

    [['OPERADOR:', userName],['DÍA:', dayName],['FECHA:', dateStr],['HORA:', timeStr]].forEach(([l,v],i) => {
        wsR.getCell(`B${5+i}`).value = l; wsR.getCell(`B${5+i}`).font = {bold:true};
        wsR.getCell(`C${5+i}`).value = v;
    });

    const promos = weekData[currentDay]?.promotions || [];
    const okN = promos.filter(p=>p.status==='ok').length;
    const errN = promos.filter(p=>p.status==='error').length;
    const pendN = promos.filter(p=>p.status==='pending').length;

    [['TOTAL:', promos.length],['✅ OK:', okN],['❌ ERROR:', errN],['⏳ PENDIENTES:', pendN]].forEach(([l,v],i) => {
        wsR.getCell(`B${12+i}`).value = l; wsR.getCell(`B${12+i}`).font = {bold:true};
        wsR.getCell(`C${12+i}`).value = String(v);
    });

    // Hoja del día
    const wsD = workbook.addWorksheet(dayName);
    wsD.columns = [{width:16},{width:45},{width:18},{width:14},{width:35}];
    wsD.mergeCells('A1:E1');
    const h = wsD.getCell('A1');
    h.value = `PROMOCIONES ${dayName.toUpperCase()}`;
    h.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3C72'}};
    h.font = {bold:true,size:14,color:{argb:'FFFFFFFF'},name:'Calibri'};
    h.alignment = {horizontal:'center',vertical:'middle'};
    wsD.getRow(1).height = 30;

    const headerRow = wsD.addRow(['CÓDIGO','PROGRAMA/NOMBRE','NIVEL','ESTADO','COMENTARIOS']);
    headerRow.eachCell(cell => {
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF2A5298'}};
        cell.font = {bold:true,color:{argb:'FFFFFFFF'}};
        cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
        cell.alignment = {horizontal:'center',vertical:'middle',wrapText:true};
    });
    headerRow.height = 22;

    const sorted = [...promos].sort((a,b) => ({ok:0,error:1,pending:2}[a.status]||2) - ({ok:0,error:1,pending:2}[b.status]||2));
    sorted.forEach(p => {
        const statusText = p.status==='ok'?'✅ OK':p.status==='error'?'❌ ERROR':'⏳ PENDIENTE';
        const row = wsD.addRow([p.code||'', p.name||'', p.level||'', statusText, p.comments||'']);
        row.eachCell(cell => {
            cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
            cell.alignment = {vertical:'middle',wrapText:true};
        });
        const sc = row.getCell(4);
        if (p.status==='ok') { sc.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF00B050'}}; sc.font={color:{argb:'FFFFFFFF'},bold:true}; }
        else if (p.status==='error') { sc.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFF0000'}}; sc.font={color:{argb:'FFFFFFFF'},bold:true}; }
        else { sc.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFC000'}}; sc.font={bold:true}; }
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    const a = document.createElement('a'); a.href=url; a.download=`Control_${dayName}_${dateStr.replace(/\//g,'-')}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);

    showAlert('✅ Excel exportado', 'success');
    await trackChange('new', 'Exportación Excel realizada');
}

// ===== 20. MAIL =====
function openMailClient() {
    const promos = weekData[currentDay]?.promotions || [];

    // Bloquear si hay promociones pendientes en el día actual
    if (promos.length === 0) {
        showAlert('⚠️ No hay promociones cargadas para este día', 'warning');
        return;
    }

    const pending = promos.filter(p => p.status === 'pending');
    if (pending.length > 0) {
        showAlert(
            `⛔ No puedes enviar el correo. Faltan ${pending.length} promoción(es) sin revisar en ${dayNames[daysOfWeek.indexOf(currentDay)]}. Marca todas como OK o ERROR primero.`,
            'error'
        );
        return;
    }

    // Mostrar modal con checklist
    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.id = 'checklistModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">✅ Checklist de Revisión</div>
            <div style="margin-bottom:20px;">
                <p style="font-weight:600;margin-bottom:15px;">Confirma que has revisado todo antes de enviar:</p>
                <label style="display:flex;align-items:center;margin-bottom:12px;cursor:pointer;">
                    <input type="checkbox" id="check1" style="margin-right:10px;width:18px;height:18px;cursor:pointer;">
                    <span>✅ Revisé todas las promociones del día</span>
                </label>
                <label style="display:flex;align-items:center;margin-bottom:12px;cursor:pointer;">
                    <input type="checkbox" id="check2" style="margin-right:10px;width:18px;height:18px;cursor:pointer;">
                    <span>✅ Revisé los enlatados</span>
                </label>
                <label style="display:flex;align-items:center;margin-bottom:12px;cursor:pointer;">
                    <input type="checkbox" id="check3" style="margin-right:10px;width:18px;height:18px;cursor:pointer;">
                    <span>✅ Está actualizado la Hora</span>
                </label>
                <label style="display:flex;align-items:center;margin-bottom:12px;cursor:pointer;">
                    <input type="checkbox" id="check4" style="margin-right:10px;width:18px;height:18px;cursor:pointer;">
                    <span>✅ Revisé las vías de LP y CH</span>
                </label>
            </div>
            <div class="modal-actions">
                <button onclick="document.getElementById('checklistModal').remove()">Cancelar</button>
                <button onclick="confirmSendMail()" class="success">📧 Enviar Correo</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function confirmSendMail() {
    const allChecked = document.getElementById('check1').checked &&
                       document.getElementById('check2').checked &&
                       document.getElementById('check3').checked &&
                       document.getElementById('check4').checked;

    if (!allChecked) {
        showAlert('⚠️ Debes marcar todos los items del checklist', 'warning');
        return;
    }

    const promos = weekData[currentDay]?.promotions || [];
    const dayName   = dayNames[daysOfWeek.indexOf(currentDay)];
    const dateStr   = new Date().toLocaleDateString('es-ES');
    const okCount   = promos.filter(p => p.status === 'ok').length;
    const errCount  = promos.filter(p => p.status === 'error').length;

    const recipients = 'amilkar.montano@unitel.com.bo;mathias@unitel.com.bo;csoria@unitel.com.bo';

    const subject = encodeURIComponent(
        `Control de Promociones ${dayName} ${dateStr} — ${userName}`
    );

    const promoLines = promos.map(p =>
        `  ${p.status === 'ok' ? '✅' : '❌'} [${p.code || '-'}] ${p.name || ''}${p.comments ? ' — ' + p.comments : ''}`
    ).join('\n');

    const body = encodeURIComponent(
        `Equipo UNITEL,\n\n` +
        `Revisión completada del ${dayName} ${dateStr}.\n\n` +
        `Operador: ${userName}\n` +
        `Total: ${promos.length} | ✅ OK: ${okCount} | ❌ Error: ${errCount}\n\n` +
        `DETALLE:\n${promoLines}\n\n` +
        `Saludos,\n${userName}`
    );

    window.location.href = `mailto:${recipients}?subject=${subject}&body=${body}`;
    showAlert('✅ Cliente de correo abierto con el resumen del día', 'success');
    document.getElementById('checklistModal').remove();
}

// ===== 21. HELPERS =====
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

function showAlert(message, type) {
    const el = document.getElementById('alert');
    el.textContent = message; el.className = `alert show ${type}`;
    setTimeout(() => el.classList.remove('show'), 4000);
}

// ===== 22. IMPORTAR XLSM SEMANAL =====
// Mapeo de nombre de hoja → clave interna
const sheetDayMap = {
    'lunes':     'monday',
    'martes':    'tuesday',
    'miércoles': 'wednesday',
    'miercoles': 'wednesday',
    'jueves':    'thursday',
    'viernes':   'friday',
    'sábado':    'saturday',
    'sabado':    'saturday',
    'domingo':   'sunday'
};

// Mapeo de nivel del archivo → valor interno
function normalizeLevel(rawLevel) {
    if (!rawLevel) return 'generica';
    const l = rawLevel.toString().trim().toUpperCase();
    if (l.includes('SANTA CRUZ') || l.includes('SC') || l.includes('SCZ')) return 'local_scz';
    if (l.includes('LA PAZ') || l.includes('LP')) return 'local_lp';
    if (l.includes('COCHABAMBA') || l.includes('CBA') || l.includes('CBBA') || l.includes('CH')) return 'local_ch';
    if (l.includes('GENERICA') || l.includes('GENÉRICA')) return 'generica';
    if (l.trim() === '') return 'generica';
    return 'generica';  // default para cualquier otro valor
}

let weeklyImportData = {};   // { monday: [...], tuesday: [...], ... } buffer previo a confirmar

function openImportWeeklyModal() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden importar', 'error');
        return;
    }
    weeklyImportData = {};
    document.getElementById('weeklyImportStep1').style.display = 'block';
    document.getElementById('weeklyImportStep2').style.display = 'none';
    document.getElementById('weeklyImportConfirmBtn').style.display = 'none';
    document.getElementById('weeklyImportFileInput').value = '';

    const zone = document.getElementById('weeklyImportDropZone');
    zone.ondragover = e => { e.preventDefault(); zone.classList.add('drag-over'); };
    zone.ondragleave = () => zone.classList.remove('drag-over');
    zone.ondrop = e => {
        e.preventDefault(); zone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) processWeeklyFile(e.dataTransfer.files[0]);
    };

    document.getElementById('weeklyImportModal').classList.add('active');
}

function handleWeeklyImportFile(e) {
    if (e.target.files[0]) processWeeklyFile(e.target.files[0]);
}

function processWeeklyFile(file) {
    if (!file.name.match(/\.(xls[xm]?)$/i)) {
        showAlert('❌ Solo se aceptan archivos .xlsx o .xlsm', 'error'); return;
    }
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
            parseWeeklyWorkbook(wb, file.name);
        } catch(err) {
            showAlert('❌ Error leyendo el archivo: ' + err.message, 'error');
            console.error(err);
        }
    };
    reader.readAsArrayBuffer(file);
}

function parseWeeklyWorkbook(wb, filename) {
    weeklyImportData = {};
    let totalFound = 0;
    const summaryRows = [];

    wb.SheetNames.forEach(sheetName => {
        const key = sheetDayMap[sheetName.toLowerCase().trim()];
        if (!key) return;   // saltear hojas que no son días

        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: false });
        const promos = [];
        const seenCodes = new Set();

        rows.forEach((row, idx) => {
            if (idx === 0) return;  // saltar encabezado
            if (!row || !row[0]) return;  // saltar filas vacías

            const code  = (row[0] || '').toString().trim();
            const name  = (row[1] || '').toString().trim();
            const nivel = (row[2] || '').toString().trim();

            if (!code || !name) return;
            if (seenCodes.has(code.toLowerCase())) return;
            seenCodes.add(code.toLowerCase());

            const category = detectCategoryFromDescription(name);
            const level    = normalizeLevel(nivel);

            promos.push({ cod: code, desc: name, category, level, rawLevel: nivel });
        });

        weeklyImportData[key] = promos;
        totalFound += promos.length;
        summaryRows.push({ day: key, dayName: dayNames[daysOfWeek.indexOf(key)], count: promos.length });
    });

    if (totalFound === 0) {
        showAlert('⚠️ No se encontraron promociones en ninguna hoja del archivo', 'warning'); return;
    }

    // Mostrar paso 2: resumen por día
    document.getElementById('weeklyImportStep1').style.display = 'none';
    document.getElementById('weeklyImportStep2').style.display = 'block';
    document.getElementById('weeklyImportConfirmBtn').style.display = 'inline-block';

    // Tabla resumen por día
    const summaryBody = document.getElementById('weeklyImportSummaryBody');
    summaryBody.innerHTML = '';
    summaryRows.forEach(r => {
        const existing = weekData[r.day]?.promotions?.length || 0;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${r.dayName}</strong></td>
            <td style="text-align:center;">${r.count}</td>
            <td style="text-align:center;">${existing > 0
                ? `<span style="color:#e67e22;font-weight:600;">${existing} existentes</span>`
                : '<span style="color:#27ae60;">Vacío ✓</span>'}</td>`;
        summaryBody.appendChild(tr);
    });

    document.getElementById('weeklyImportFilename').textContent = `📂 ${filename} — ${totalFound} promociones totales en ${summaryRows.length} días`;
}

// ===== ELIMINAR PROMOCIONES DEL DÍA =====
async function deleteDayPromotions() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden eliminar', 'error');
        return;
    }
    const promos = weekData[currentDay]?.promotions || [];
    const dayLabel = dayNames[daysOfWeek.indexOf(currentDay)];

    if (promos.length === 0) {
        showAlert(`⚠️ No hay promociones en ${dayLabel}`, 'warning');
        return;
    }

    if (!confirm(`¿Eliminar las ${promos.length} promociones del ${dayLabel}? Esta acción no se puede deshacer.`)) return;

    const { error } = await db.from('promotions').delete().eq('day', currentDay);
    if (error) { showAlert('❌ Error eliminando: ' + error.message, 'error'); return; }

    weekData[currentDay].promotions = [];
    await trackChange('deleted', `Eliminadas todas las promociones del ${dayLabel}`);
    showAlert(`✅ Promociones del ${dayLabel} eliminadas`, 'success');
    renderPromotions();
    updateStatistics();
}

// ===== ELIMINAR PROMOCIONES DE TODA LA SEMANA =====
async function deleteWeekPromotions() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden eliminar', 'error');
        return;
    }
    const total = daysOfWeek.reduce((sum, d) => sum + (weekData[d]?.promotions?.length || 0), 0);

    if (total === 0) {
        showAlert('⚠️ No hay promociones cargadas en ningún día', 'warning');
        return;
    }

    if (!confirm(`⚠️ ¿Eliminar TODAS las promociones de la semana (${total} en total)?\n\nEsta acción borrará todos los días y no se puede deshacer.`)) return;

    // Borrar todas de una sola vez en Supabase
    const { error } = await db.from('promotions').delete().in('day', daysOfWeek);
    if (error) { showAlert('❌ Error eliminando: ' + error.message, 'error'); return; }

    daysOfWeek.forEach(d => { weekData[d] = { promotions: [] }; });
    await trackChange('deleted', `Eliminadas todas las promociones de la semana (${total} total)`);
    showAlert(`✅ Semana completa eliminada (${total} promociones)`, 'success');
    renderPromotions();
    updateStatistics();
}

async function executeWeeklyImport() {
    if (!Object.keys(weeklyImportData).length) {
        showAlert('❌ Sin datos para importar', 'error'); return;
    }
    const conflictMode = document.getElementById('weeklyImportConflictMode').value;
    const btn = document.getElementById('weeklyImportConfirmBtn');
    btn.disabled = true;

    let totalInserted = 0;
    let totalSkipped  = 0;

    try {
        for (const [day, promos] of Object.entries(weeklyImportData)) {
            if (!promos.length) continue;

            if (conflictMode === 'replace') {
                await db.from('promotions').delete().eq('day', day);
                if (!weekData[day]) weekData[day] = { promotions: [] };
                weekData[day].promotions = [];
            }

            const existingCodes = new Set(
                (weekData[day]?.promotions || []).map(p => (p.code || '').toLowerCase())
            );

            const toInsert = [];
            promos.forEach(p => {
                if (conflictMode === 'skip_duplicates' && existingCodes.has(p.cod.toLowerCase())) {
                    totalSkipped++; return;
                }
                const id = 'promo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                toInsert.push({
                    id, day, code: p.cod, name: p.desc, category: p.category,
                    level: p.level, comments: '', status: 'pending',
                    imported_from_xls: true, created_by: userName,
                    created_at: new Date().toISOString(), last_modified: new Date().toISOString()
                });
            });

            if (toInsert.length > 0) {
                const { error } = await db.from('promotions').insert(toInsert);
                if (error) throw error;
                if (!weekData[day]) weekData[day] = { promotions: [] };
                toInsert.forEach(r => weekData[day].promotions.push(mapDbToPromo(r)));
                totalInserted += toInsert.length;
            }
        }

        await trackChange('new', `Importación XLSM semanal: ${totalInserted} promociones cargadas en toda la semana`);

        let msg = `✅ ${totalInserted} promociones importadas en toda la semana`;
        if (totalSkipped > 0) msg += ` (${totalSkipped} duplicadas omitidas)`;
        showAlert(msg, 'success');

        closeModal('weeklyImportModal');
        generateDayTabs();
        renderPromotions();
        updateStatistics();
    } catch(e) {
        showAlert('❌ Error importando: ' + e.message, 'error');
        console.error(e);
    } finally {
        btn.disabled = false;
    }
}