
const SUPABASE_URL = 'https://cdfkwjdbwpjvxlkgehkm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNkZmt3amRid3Bqdnhsa2dlaGttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NDQxODcsImV4cCI6MjA5MzMyMDE4N30.VmNg_e5wNe7zAzEWn5i6jYZcUFjjL0ByO7stKOfKRKw';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

let __filterDuplicatesActive = false; // Estado persistente del filtro de duplicados

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

const categoryLabels = {
    diario:'DIARIO', streaming:'STREAMING', radio:'RADIO', digital:'DIGITAL',
    mundial:'MUNDIAL', apagon:'APAGÓN',
    momento_simpson:'MOMENTO SIMPSON', id:'ID', masterchef:'MASTERCHEF',
    presentacion:'PRESENTACIÓN', despedida:'DESPEDIDA'
};

// ===== 3. INICIALIZACIÓN =====
window.addEventListener('load', async () => {
    document.addEventListener('contextmenu', event => event.preventDefault());
    daysOfWeek.forEach(d => { weekData[d] = { promotions: [] }; });

    const minWait = new Promise(r => setTimeout(r, 800));

    try {
        await Promise.all([
            db.from('promotions').select('id').limit(1),
            minWait
        ]);
    } catch (e) {
        console.error('Supabase connection error:', e);
    } finally {
        // Verificar si hay sesión guardada en localStorage
        const savedName = localStorage.getItem('unitel_userName');
        const savedRole = localStorage.getItem('unitel_userRole');

        if (savedName && savedRole) {
            // Restaurar sesión automáticamente
            userName = savedName;
            userRole = savedRole;
            isLoggedIn = true;

            document.getElementById('loadingScreen').style.display = 'none';
            document.getElementById('loginScreen').style.display = 'none';
            document.getElementById('mainContainer').style.display = 'block';

            await initializeApp();
        } else {
            // No hay sesión guardada, mostrar login
            document.getElementById('loadingScreen').style.display = 'none';
            document.getElementById('loginScreen').style.display = 'flex';
        }
    }

    document.addEventListener('keypress', e => {
        if (e.key === 'Enter') {
            const active = document.activeElement.id;
            if (active === 'loginCode' || active === 'loginName') login();
        }
    });
});

// Función auxiliar para inicializar la app después del login (reutilizable)
async function initializeApp() {
    await loadPromoCategoriesForAddModal();

    const roleLabel = userRole === 'admin' ? '👨‍💼 ADMINISTRADOR' : '👤 OPERADOR';
    document.getElementById('userBadge').textContent = `${roleLabel} • ${userName}`;
    
    const today = new Date();
    const dateStr = today.toLocaleDateString('es-ES', {weekday:'long',year:'numeric',month:'long',day:'numeric'});
    document.getElementById('currentDate').textContent = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);

    applyRolePermissions();

    await loadAllData();

    generateDayTabs();
    await loadCategoriesForFilterUI();
    renderFilterUI();
    applyPromotionsViewMode();
    renderPromotions();
    attachSearchListeners();

    loadProgramImage();
    generateCalendar();
    updateStatistics();
    setupRealtime();
    initWeeklyAutoRotation();
}

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
        document.getElementById('loginError').textContent = '❌ Código incorrecto.';
        document.getElementById('loginCode').value = '';
        setTimeout(() => document.getElementById('loginError').textContent = '', 4000);
        return;
    }

    userName = nameInput;
    userRole = role;
    isLoggedIn = true;

    // Guardar sesión en localStorage para persistencia
    localStorage.setItem('unitel_userName', userName);
    localStorage.setItem('unitel_userRole', userRole);

    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainContainer').style.display = 'block';

    await initializeApp();
}

function applyRolePermissions() {
    const isOperator = userRole === 'operator';

    const btnAdminCategories = document.getElementById('btnAdminCategories');
    const isAdmin = userRole === 'admin';
    if (btnAdminCategories) btnAdminCategories.style.display = isAdmin ? '' : 'none';

    // Permiso admin-only para reordenar
    const btnReorderMode = document.getElementById('btnReorderMode');
    const btnReorderReset = document.getElementById('btnReorderReset');
    if (btnReorderMode) btnReorderMode.style.display = isAdmin ? '' : 'none';
    if (btnReorderReset) btnReorderReset.style.display = isAdmin ? '' : 'none';



    // Restaurar visibilidad de todo (por si venía de sesión anterior en la misma página)
    document.querySelectorAll('.tab-btn').forEach(btn => btn.style.display = '');
    ['btnAddPromo','btnImportDay','btnCopyPromo','btnDeleteWeek','btnDeleteDay',
     'btnImportWeekly','btnImportNextWeek','btnViewSavedXlsm','btnDeleteWeekFull'].forEach(id => {
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
        ['btnImportWeekly','btnImportNextWeek','btnViewSavedXlsm','btnDeleteWeekFull'].forEach(id => {
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
    
    // Limpiar sesión de localStorage
    localStorage.removeItem('unitel_userName');
    localStorage.removeItem('unitel_userRole');
    
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('mainContainer').style.display = 'none';
    document.getElementById('loginCode').value = '';
    document.getElementById('loginName').value = '';
    document.getElementById('realtimeDot').className = '';
}

// ===== 5. SUPABASE DATA LOAD =====
async function loadAllData() {
    daysOfWeek.forEach(d => { weekData[d] = { promotions: [] }; });

    // Cargar promociones usando el orden manual cuando la migración existe.
    let { data: promos, error } = await db
        .from('promotions')
        .select('*')
        .order('day', { ascending: true })
        .order('sort_order', { ascending: true });

    // Instancias antiguas pueden no tener sort_order todavía.
    if (error && /sort_order|column/i.test(error.message || '')) {
        ({ data: promos, error } = await db
            .from('promotions')
            .select('*')
            .order('day', { ascending: true })
            .order('created_at', { ascending: true }));
    }

    if (error) {
        console.error('Error cargando promociones:', error);
        showAlert('❌ No se pudieron cargar las promociones: ' + error.message, 'error');
        return;
    }

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
    else if (tabName === 'promociones') {
        applyPromotionsViewMode();
        renderPromotions();
    }
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
    // Categoría para la promoción: viene del select del modal.
    // OJO: si el select está siendo poblado desde Supabase (admin CRUD),
    // debemos conservar el slug interno.
    const category = document.getElementById('promotionCategory')?.value || '';
    const level    = document.getElementById('promotionLevel').value;
    const comments = document.getElementById('promotionComments').value.trim();

    if (!code || !name || !category || !level) {
        showAlert('❌ Completa código, nombre, categoría y nivel', 'error'); return;
    }

    const btn = document.querySelector('#promotionModal .success');
    btn.disabled = true;

    try {
        if (editingPromotionId) {
            // Editar promoción existente: solo se actualiza el día donde está la promo.
            const { error } = await db.from('promotions').update({
                code, name, category, level, comments, last_modified: new Date().toISOString()
            }).eq('id', editingPromotionId);
            if (error) throw error;

            const promo = (weekData[currentDay]?.promotions || []).find(p => p.id === editingPromotionId);
            if (promo) Object.assign(promo, { code, name, category, level, comments, lastModified: new Date() });

            await trackChange('modified', `Promoción actualizada: ${code} - ${name}`);
            showAlert('✅ Promoción actualizada', 'success');
        } else {
            // Crear promoción en 1 o varios días
            const modeEl = document.querySelector('input[name="promoDestMode"]:checked');
            const mode = modeEl ? modeEl.value : 'only_current';

            const selectedDays = new Set();
            if (mode === 'multiple') {
                document.querySelectorAll('input.promo-dest-day:checked').forEach(cb => selectedDays.add(cb.value));
            } else {
                selectedDays.add(currentDay);
            }

            // Si multi-día fue seleccionado pero no marcaste nada, usar currentDay
            if (selectedDays.size === 0) selectedDays.add(currentDay);

            const daysArr = Array.from(selectedDays);

            let insertedCount = 0;
            for (const day of daysArr) {
                const newId = 'promo_' + Date.now() + '_' + Math.random().toString(36).substr(2,9);
                const row = {
                    id: newId,
                    day,
                    code,
                    name,
                    category,
                    level,
                    comments,
                    status: 'pending',
                    imported_from_xls: false,
                    created_by: userName,
                    created_at: new Date().toISOString(),
                    last_modified: new Date().toISOString()
                };

                const { error } = await db.from('promotions').insert(row);
                if (error) throw error;

                if (!weekData[day]) weekData[day] = { promotions: [] };
                weekData[day].promotions.push(mapDbToPromo(row));
                insertedCount++;
            }

            await trackChange('new', `Promoción agregada en ${insertedCount} día(s): ${code} - ${name}`);
            showAlert(insertedCount > 1 ? `✅ Promoción agregada en ${insertedCount} días` : '✅ Promoción agregada', 'success');
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
        .update({ status: 'pending', comments: '', last_modified: new Date().toISOString() })
        .in('id', promoIds);
    
    if (error) { showAlert('❌ Error: ' + error.message, 'error'); return; }

    promos.forEach(p => { p.status = 'pending'; p.comments = ''; });
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
        .update({ status: 'pending', comments: '', last_modified: new Date().toISOString() })
        .in('id', allPromoIds);
    
    if (error) { showAlert('❌ Error: ' + error.message, 'error'); return; }

    daysOfWeek.forEach(d => {
        weekData[d]?.promotions?.forEach(p => { p.status = 'pending'; p.comments = ''; });
    });

    await trackChange('modified', `Limpiada la semana: ${total} promociones en PENDIENTES`);
    showAlert(`✅ Semana completa limpia (${total} PENDIENTES)`, 'success');
    renderPromotions();
    updateStatistics();
}

// ===== 12. RENDER PROMOTIONS =====

function getAllowedLevelsForLocalFilter(levelFilter) {
    // Regla pedida:
    // - Filtrar SC (local_scz) => SC + SC-LP + SC-CH
    // - Filtrar LP (local_lp)  => LP + LP-CH + SC-LP
    // - Filtrar CH (local_ch)  => CH + LP-CH + SC-CH
    // Para locales combinados, se permite solo ese exacto (según confirmación).
    if (!levelFilter || !levelFilter.startsWith('local_')) return [];

    const map = {
        local_scz: ['local_scz', 'local_scz_lp', 'local_scz_ch'],
        local_lp: ['local_lp', 'local_lp_ch', 'local_scz_lp'],
        local_ch: ['local_ch', 'local_lp_ch', 'local_scz_ch'],
        local_scz_lp: ['local_scz_lp'],
        local_scz_ch: ['local_scz_ch'],
        local_lp_ch: ['local_lp_ch']
    };

    return map[levelFilter] || [levelFilter];
}

function isReorderMode() {
    return !!(document.getElementById('btnReorderMode')?.dataset.active === 'true');
}

async function reorderPromotionsOnDrop(draggedId, targetId) {
    const day = currentDay;
    const promos = weekData[day]?.promotions || [];
    const draggedIdx = promos.findIndex(p => p.id === draggedId);
    const targetIdx = promos.findIndex(p => p.id === targetId);
    if (draggedIdx === -1 || targetIdx === -1) return;

    // Insert dragged before target
    const [moved] = promos.splice(draggedIdx, 1);
    promos.splice(targetIdx, 0, moved);

    // Reassign sort_order sequentially
    const updates = promos.map((p, i) => ({ id: p.id, sort_order: i + 1 }));

    // Batch update
    const { error } = await db.from('promotions')
        .upsert(updates.map(u => ({ id: u.id, day, sort_order: u.sort_order })), { onConflict: 'id' });

    if (error) {
        showAlert('❌ Error reordenando: ' + error.message, 'error');
        // reload local from DB state would be safest, but for now revert by re-rendering
    }

    renderPromotions();
}

// Detectar códigos duplicados en las promociones de un día
function findDuplicateCodes(dayPromos) {
    const codeCount = {};
    dayPromos.forEach(p => {
        if (p.code) {
            const key = p.code.trim().toLowerCase();
            codeCount[key] = (codeCount[key] || 0) + 1;
        }
    });
    const dupCodes = new Set();
    Object.entries(codeCount).forEach(([code, count]) => {
        if (count > 1) dupCodes.add(code);
    });
    return dupCodes;
}

function renderPromotions() {
    applyPromotionsViewMode();

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
    const filterDuplicates = __filterDuplicatesActive;

    const duplicateCodes = findDuplicateCodes(promos);
    const hasDuplicates = duplicateCodes.size > 0;

    // Barra informativa de duplicados
    let duplicatesBar = document.getElementById('duplicatesBar');
    if (!duplicatesBar) {
        duplicatesBar = document.createElement('div');
        duplicatesBar.id = 'duplicatesBar';
        const containerParent = container.parentNode;
        containerParent.insertBefore(duplicatesBar, container);
    }
    if (hasDuplicates) {
        // Contar cuántas promos son duplicadas (excluyendo la primera de cada código)
        const seen = new Set();
        let duplicateCount = 0;
        promos.forEach(p => {
            if (p.code) {
                const key = p.code.trim().toLowerCase();
                if (duplicateCodes.has(key)) {
                    if (seen.has(key)) duplicateCount++;
                    else seen.add(key);
                }
            }
        });
        duplicatesBar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;background:#fff8e1;border:1px solid #ffd54f;border-radius:8px;margin-bottom:10px;flex-wrap:wrap;';
        const filterBtnBg = __filterDuplicatesActive
            ? 'linear-gradient(135deg,#ff9800 0%,#f57c00 100%)'
            : '#f5f5f5';
        const filterBtnColor = __filterDuplicatesActive ? 'white' : '#333';
        const filterBtnBorder = __filterDuplicatesActive ? 'transparent' : '#ccc';
        const filterBtnGlow = __filterDuplicatesActive
            ? 'animation:glow-pulse 1.5s ease-in-out infinite;box-shadow:0 0 10px rgba(255,152,0,0.5);'
            : '';
        duplicatesBar.innerHTML = `
            <style>
                @keyframes glow-pulse {
                    0%, 100% { box-shadow: 0 0 5px rgba(255,152,0,0.3); }
                    50% { box-shadow: 0 0 18px rgba(255,152,0,0.8); }
                }
            </style>
            <span style="font-weight:600;color:#e65100;">⚠️ ${duplicateCount} promociones duplicadas encontradas</span>
            <button onclick="deleteAllDuplicates()" style="padding:6px 12px;background:linear-gradient(135deg,#e74c3c 0%,#c0392b 100%);color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">🗑️ Borrar todos los duplicados</button>
            <button id="btnFilterDuplicates" data-active="${__filterDuplicatesActive}" onclick="toggleFilterDuplicates(this)" style="padding:6px 12px;background:${filterBtnBg};color:${filterBtnColor};border:1px solid ${filterBtnBorder};border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;${filterBtnGlow}">🔍 Revisar duplicados</button>
        `;
    } else {
        duplicatesBar.style.display = 'none';
        duplicatesBar.innerHTML = '';
    }

    // Determinar si es filtro de locales o categoría
    const isLocalFilter = catFilter.startsWith('local_');
    const levelFilter = isLocalFilter ? catFilter : '';

    // Expandir filtro de locales para que un local base muestre combinaciones relacionadas.
    // Ej: SC -> SC-LP y SC-CH
    // Ej: LP -> LP-CH y SC-LP
    // Ej: CH -> LP-CH y SC-CH
    const localLevelsAllowed = isLocalFilter ? getAllowedLevelsForLocalFilter(levelFilter) : null;


    promos.forEach((promo, idx) => {
        // Aplicar filtros
        const alltext = (promo.name+' '+promo.code+' '+promo.comments+' '+promo.category+' '+promo.level).toLowerCase();
        if (searchText && !alltext.includes(searchText)) return;
        
        // Filtro de categoría o nivel
        if (isLocalFilter) {
            // Filtro por nivel de local (con expansión)
            if (localLevelsAllowed && promo.level && !localLevelsAllowed.includes(promo.level)) return;
            if (localLevelsAllowed && (!promo.level || promo.level === '')) return;
        } else if (catFilter) {

            // Filtro por categoría
            if (promo.category !== catFilter) return;
        }

        
        if (filterPending && promo.status !== 'pending') return;

        // Filtro de duplicados
        if (filterDuplicates) {
            const isDup = promo.code && duplicateCodes.has(promo.code.trim().toLowerCase());
            if (!isDup) return;
        }

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
        const isVerticalMode = (localStorage.getItem('promotionsViewMode') || 'blocks') === 'vertical';
        let cardStyle = `background:${bgColor};border-color:${borderColor};`;
        card.style.cssText = cardStyle;

        const statusBadge = promo.status === 'ok'
            ? '<span class="badge ok">✅ OK</span>'
            : promo.status === 'error' ? '<span class="badge error">❌ ERROR</span>'
            : '<span class="badge pending">⏳ PENDIENTE</span>';

        const xlsTag = promo.importedFromXls
            ? '<span style="background:#f0e6ff;color:#7b2ff7;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:700;">📥 XLS</span>' : '';

        // Detectar si esta promoción es duplicada
        const isDuplicate = promo.code && duplicateCodes.has(promo.code.trim().toLowerCase());
        const duplicateBadge = isDuplicate ? '<span style="background:#fff3e0;color:#e65100;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid #ffb74d;">🔁 Duplicado</span>' : '';

        // En modo vertical, ocultar badge y xlsTag para compactar
        const showBadge = !isVerticalMode;
        const showXlsTag = !isVerticalMode;

        // Visualización compacta: código - nombre en 1-2 líneas
        const titleText = escapeHtml(promo.code ? promo.code : 'SIN CÓDIGO');
        const nameText = escapeHtml(promo.name || '');
        
        let html = `
            <div class="promotion-header">
                <div class="promotion-title-compact">${titleText} ${duplicateBadge}</div>
            <div style="display:flex;gap:6px;align-items:center;">${showXlsTag ? xlsTag : ''}${showBadge ? statusBadge : ''}</div>
            </div>
            <div class="promotion-name-line">${nameText}</div>
            <div class="promotion-meta">
                <span>📁 ${escapeHtml(categoryLabels[promo.category] || promo.category || '-')}</span>
                ${(userRole === 'operator' && (!promo.level || promo.level === 'generica')) ? '' : (() => {



                    const lvl = promo.level || '';
                    let label = '-';
                    if (lvl === 'local_scz') label = 'SC';
                    else if (lvl === 'local_lp') label = 'LP';
                    else if (lvl === 'local_ch') label = 'CH';
                    else if (lvl === 'local_scz_lp') label = 'SC-LP';
                    else if (lvl === 'local_scz_ch') label = 'SC-CH';
                    else if (lvl === 'local_lp_ch') label = 'LP-CH';
                    else label = lvl;
                    return `<span>📍 ${escapeHtml(label)}</span>`;
                })()}

                ${promo.createdBy ? `<span>Injestado por: ${escapeHtml(promo.createdBy)}</span>` : ''}
            </div>`;
        
        if (promo.comments) {
            html += `<div class="promotion-comment">${escapeHtml(promo.comments)}</div>`;
        }
        // Botones según rol
        let actionButtons = '';
        if (userRole === 'admin') {
            actionButtons = `
                <button onclick="editPromotion('${promo.id}')" id="btnEditPromo">✏️ Editar</button>
                <button onclick="deletePromotion('${promo.id}')" id="btnDeletePromo" class="danger">🗑️ Eliminar</button>
                ${isDuplicate ? `<button onclick="deleteDuplicatePromotion('${promo.id}')" style="padding:6px 10px;background:linear-gradient(135deg,#e65100 0%,#bf360c 100%);color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">🗑️ Borrar este duplicado</button>` : ''}
            `;
        }

        // Botones comunes (todos pueden marcar OK/ERROR)
        actionButtons += `
            <button onclick="markPromotionStatus('${promo.id}','ok')" class="success">✅ OK</button>
            <button onclick="openErrorCommentModal('${promo.id}')" class="danger">❌ ERROR</button>
        `;

        html += `<div class="promotion-actions">${actionButtons}</div>`;

        card.innerHTML = html;

        // Drag & Drop reordenamiento (admin)
        if (userRole === 'admin') {
            card.draggable = true;
            card.dataset.promoId = promo.id;
            card.dataset.promoIndex = idx;
            card.classList.add('promo-draggable');

            card.addEventListener('dragstart', (e) => {
                if (!isReorderMode()) return;
                e.dataTransfer.setData('text/plain', promo.id);
                card.classList.add('dragging');
            });

            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
            });

            card.addEventListener('dragover', (e) => {
                if (!isReorderMode()) return;
                e.preventDefault();
            });

            card.addEventListener('drop', async (e) => {
                if (!isReorderMode()) return;
                e.preventDefault();

                const draggedId = e.dataTransfer.getData('text/plain');
                const targetId = promo.id;
                if (!draggedId || !targetId || draggedId === targetId) return;

                await reorderPromotionsOnDrop(draggedId, targetId);
            });
        }

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

function getFilterDefinitions() {
    // Para locales mantenemos lógica actual hardcodeada.
    // Para categorías (DIARIO/STREAMING/...) ahora vienen de Supabase via loadCategoriesForFilterUI().
    return {
        categorySelect: {
            categories: [],
            locales: [
                { id:'local_scz', label:'SANTA CRUZ (SC)' },
                { id:'local_lp', label:'LA PAZ (LP)' },
                { id:'local_ch', label:'COCHABAMBA (CH)' }
            ]
        }
    };
}


function renderFilterUI() {
    const select = document.getElementById('daySearchCategory');
    if (!select) return;

    const defs = getFilterDefinitions();

    // preservar placeholder
    select.innerHTML = '<option value="">- Filtro -</option>';

    const optgroupCat = document.createElement('optgroup');
    optgroupCat.label = '📺 CATEGORÍAS';

    // Las categorías se inyectan desde loadCategoriesForFilterUI()
    const existing = (window.__categoryFilterCache || []);
    existing.forEach(c => {
        const o = document.createElement('option');
        o.value = c.slug;
        o.textContent = c.label;
        optgroupCat.appendChild(o);
    });
    select.appendChild(optgroupCat);

    const optgroupLocales = document.createElement('optgroup');
    optgroupLocales.label = '📍 LOCALES';
    defs.categorySelect.locales.forEach(l => {
        const o = document.createElement('option');
        o.value = l.id;
        o.textContent = l.label;
        optgroupLocales.appendChild(o);
    });
    select.appendChild(optgroupLocales);
}

async function loadCategoriesForFilterUI() {
    try {
        const { data, error } = await db
            .from('promo_categories')
            .select('slug,label')
            .order('created_at', { ascending: true });
        if (error) throw error;
        window.__categoryFilterCache = (data || []).map(r => ({ slug: r.slug, label: r.label }));
    } catch (e) {
        console.error('Error cargando categorías:', e);
        window.__categoryFilterCache = [];
    }
}

async function loadPromoCategoriesForAddModal() {
    const select = document.getElementById('promotionCategory');
    if (!select) return;

    // Inicializar siempre con el placeholder
    select.innerHTML = '<option value="">- Seleccionar -</option>';

    // Usar el cache del filtro si existe; si no, cargar.
    const categories = window.__categoryFilterCache;
    if (!Array.isArray(categories)) {
        await loadCategoriesForFilterUI();
    }

    const cats = (window.__categoryFilterCache || []).slice();
    cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.slug;
        opt.textContent = c.label;
        select.appendChild(opt);
    });
}

async function syncPromotionCategorySelectWithPromoCategories() {
    // Refresca el select del modal "Agregar Promoción"
    await loadPromoCategoriesForAddModal();
}

// ===== ADMIN CRUD: CATEGORÍAS =====
async function loadPromoCategories() {
    const { data, error } = await db
        .from('promo_categories')
        .select('id, slug, label')
        .order('created_at', { ascending: true });
    if (error) {
        showAlert('❌ Error cargando categorías: ' + error.message, 'error');
        return [];
    }
    return data || [];
}

function safeSlug(slug) {
    return (slug || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

async function reloadFilterUI() {
    await loadCategoriesForFilterUI();
    renderFilterUI();
    renderPromotions();
}

function openAdminCategoriesModal() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden gestionar categorías', 'error');
        return;
    }

    document.getElementById('adminCategoriesModal').classList.add('active');
    document.getElementById('adminCategoriesTitle').textContent = '🛠️ Admin Categorías';
    document.getElementById('adminCategoriesLoading').style.display = 'block';
    document.getElementById('adminCategoriesList').innerHTML = '';

    renderCategoriesAdmin();
}

async function renderCategoriesAdmin() {
    const listEl = document.getElementById('adminCategoriesList');
    const loadingEl = document.getElementById('adminCategoriesLoading');

    try {
        const categories = await loadPromoCategories();
        if (loadingEl) loadingEl.style.display = 'none';

        if (!categories.length) {
            listEl.innerHTML = '<p style="text-align:center;color:#7f8c8d;padding:20px;">No hay categorías cargadas.</p>';
            return;
        }

        listEl.innerHTML = '';
        categories.forEach(c => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:10px;align-items:center;justify-content:space-between;padding:12px 10px;background:#f9fafb;border:1px solid #e0e6ed;border-radius:8px;margin-bottom:10px;';

            const left = document.createElement('div');
            left.innerHTML = `<div style="font-weight:800;color:#1e3c72;">${escapeHtml(c.label)}</div><div style="font-size:12px;color:#7f8c8d;">slug: <span style="font-family:monospace;">${escapeHtml(c.slug)}</span></div>`;

            const actions = document.createElement('div');
            actions.style.display = 'flex';
            actions.style.gap = '8px';
            actions.style.flexWrap = 'wrap';

            const renameBtn = document.createElement('button');
            renameBtn.textContent = '✏️ Renombrar';
            renameBtn.style.padding = '8px 12px';
            renameBtn.style.background = 'linear-gradient(135deg,#3498db 0%,#2980b9 100%)';
            renameBtn.style.color = 'white';
            renameBtn.style.border = 'none';
            renameBtn.style.borderRadius = '6px';
            renameBtn.style.cursor = 'pointer';
            renameBtn.style.fontSize = '12px';
            renameBtn.style.fontWeight = '600';
            renameBtn.onclick = () => openRenameCategoryModal(c.slug, c.label);

            const delBtn = document.createElement('button');
            delBtn.className = 'danger';
            delBtn.textContent = '🗑️ Eliminar';
            delBtn.style.padding = '8px 12px';
            delBtn.onclick = () => deletePromoCategory(c.slug);

            actions.appendChild(renameBtn);
            actions.appendChild(delBtn);

            row.appendChild(left);
            row.appendChild(actions);
            listEl.appendChild(row);
        });
    } catch (e) {
        if (loadingEl) loadingEl.style.display = 'none';
        showAlert('❌ Error renderizando categorías', 'error');
        console.error(e);
    }
}

async function createPromoCategory() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden crear categorías', 'error');
        return;
    }

    const slugInput = document.getElementById('newPromoCategorySlug');
    const labelInput = document.getElementById('newPromoCategoryLabel');
    const slug = safeSlug(slugInput?.value);
    const label = (labelInput?.value || '').trim();

    if (!slug) {
        showAlert('❌ El slug no puede estar vacío', 'error');
        return;
    }
    if (!label) {
        showAlert('❌ El label no puede estar vacío', 'error');
        return;
    }

    try {
        const { error } = await db
            .from('promo_categories')
            .insert({ slug, label });

        if (error) throw error;

        showAlert('✅ Categoría creada', 'success');
        if (slugInput) slugInput.value = '';
        if (labelInput) labelInput.value = '';

        await reloadFilterUI();
        await renderCategoriesAdmin();
    } catch (e) {
        showAlert('❌ Error creando categoría: ' + e.message, 'error');
        console.error(e);
    }
}

async function deletePromoCategory(slug) {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden eliminar categorías', 'error');
        return;
    }

    if (!slug) return;

    if (!confirm(`¿Eliminar la categoría "${slug}"?\n\nSe bloqueará si existen promociones asociadas.`)) return;

    try {
        // Bloquear eliminación si hay promociones con esa categoría
        const { count, error: countError } = await db
            .from('promotions')
            .select('id', { count: 'exact', head: true })
            .eq('category', slug);

        if (countError) throw countError;

        if (count && count > 0) {
            showAlert('⛔ No se puede eliminar: existen promociones con esa categoría.', 'error');
            return;
        }

        const { error: delError } = await db
            .from('promo_categories')
            .delete()
            .eq('slug', slug);

        if (delError) throw delError;

        showAlert('🗑️ Categoría eliminada', 'success');
        await reloadFilterUI();
        await renderCategoriesAdmin();
    } catch (e) {
        showAlert('❌ Error eliminando categoría: ' + e.message, 'error');
        console.error(e);
    }
}

// ===== RENOMBRAR CATEGORÍA DESDE UI =====
function openRenameCategoryModal(slug, currentLabel) {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden renombrar categorías', 'error');
        return;
    }

    // Crear modal dinámico para renombrar
    const existingModal = document.getElementById('renameCategoryModal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.id = 'renameCategoryModal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width:500px;">
            <div class="modal-header">✏️ Renombrar Categoría</div>
            <div style="margin-bottom:15px;">
                <div style="font-size:13px;color:#7f8c8d;margin-bottom:8px;">
                    Slug: <span style="font-family:monospace;font-weight:600;color:#1e3c72;">${slug}</span>
                </div>
                <label style="font-weight:600;display:block;margin-bottom:5px;">Nuevo nombre (label):</label>
                <input type="text" id="renameCategoryInput" value="${currentLabel}" 
                    style="width:100%;padding:10px 12px;border:2px solid #dbe5f0;border-radius:8px;font-size:14px;font-family:inherit;" 
                    maxlength="80" />
            </div>
            <div class="modal-actions">
                <button onclick="document.getElementById('renameCategoryModal').remove()">Cancelar</button>
                <button class="success" onclick="confirmRenameCategory('${slug}')">💾 Guardar</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Focus en el input
    setTimeout(() => {
        const input = document.getElementById('renameCategoryInput');
        if (input) { input.focus(); input.select(); }
    }, 100);
}

async function confirmRenameCategory(slug) {
    const input = document.getElementById('renameCategoryInput');
    if (!input) return;
    const newLabel = input.value.trim();

    if (!newLabel) {
        showAlert('❌ El label no puede estar vacío', 'error');
        input.focus();
        return;
    }

    try {
        await renamePromoCategory(slug, newLabel);

        // Cerrar modal
        document.getElementById('renameCategoryModal').remove();

        showAlert(`✅ Categoría "${slug}" renombrada a "${newLabel}"`, 'success');

        // Refrescar UI
        await reloadFilterUI();
        await renderCategoriesAdmin();
        await syncPromotionCategorySelectWithPromoCategories();
    } catch (e) {
        showAlert('❌ Error renombrando categoría: ' + e.message, 'error');
        console.error(e);
    }
}

async function renamePromoCategory(slug, newLabel) {
    if (!slug || !newLabel) throw new Error('Slug y label son requeridos');

    const { error } = await db
        .from('promo_categories')
        .update({ label: newLabel })
        .eq('slug', slug);

    if (error) throw error;

    // Actualizar cache local
    if (window.__categoryFilterCache) {
        const idx = window.__categoryFilterCache.findIndex(c => c.slug === slug);
        if (idx !== -1) {
            window.__categoryFilterCache[idx].label = newLabel;
        }
    }
}



// ===== ELIMINAR TODOS LOS DUPLICADOS DEL DÍA =====
async function deleteAllDuplicates() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden borrar duplicados', 'error');
        return;
    }
    const promos = weekData[currentDay]?.promotions || [];
    const dupCodes = findDuplicateCodes(promos);
    if (dupCodes.size === 0) {
        showAlert('⚠️ No hay duplicados en este día', 'warning');
        return;
    }

    // Encontrar IDs a eliminar (todas las ocurrencias duplicadas excepto la primera de cada código)
    const seen = new Set();
    const toDelete = [];
    promos.forEach(p => {
        if (p.code) {
            const key = p.code.trim().toLowerCase();
            if (dupCodes.has(key)) {
                if (seen.has(key)) toDelete.push(p.id);
                else seen.add(key);
            }
        }
    });

    if (toDelete.length === 0) {
        showAlert('⚠️ No hay duplicados para eliminar', 'warning');
        return;
    }

    if (!confirm(`¿Eliminar ${toDelete.length} promociones duplicadas? Se conservará la primera de cada código.`)) return;

    try {
        const { error } = await db.from('promotions').delete().in('id', toDelete);
        if (error) throw error;

        // Actualizar weekData local
        weekData[currentDay].promotions = weekData[currentDay].promotions.filter(p => !toDelete.includes(p.id));

        await trackChange('deleted', `Eliminadas ${toDelete.length} promociones duplicadas del ${dayNames[daysOfWeek.indexOf(currentDay)]}`);
        showAlert(`✅ ${toDelete.length} duplicados eliminados`, 'success');
        renderPromotions();
        updateStatistics();
    } catch (e) {
        showAlert('❌ Error eliminando duplicados: ' + e.message, 'error');
        console.error(e);
    }
}

// ===== TOGGLE FILTRO DE DUPLICADOS =====
function toggleFilterDuplicates(btn) {
    __filterDuplicatesActive = !__filterDuplicatesActive;
    renderPromotions();
}

// ===== ELIMINAR PROMOCIÓN DUPLICADA ESPECÍFICA =====
async function deleteDuplicatePromotion(promotionId) {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden eliminar', 'error');
        return;
    }
    if (!confirm('¿Eliminar esta promoción duplicada?')) return;
    const { error } = await db.from('promotions').delete().eq('id', promotionId);
    if (error) { showAlert('❌ Error eliminando: ' + error.message, 'error'); return; }
    weekData[currentDay].promotions = weekData[currentDay].promotions.filter(p => p.id !== promotionId);
    await trackChange('deleted', 'Promoción duplicada eliminada');
    showAlert('✅ Duplicado eliminado', 'success');
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

function toggleReorderMode(btn) {
    if (userRole !== 'admin') return;
    const isActive = btn.dataset.active === 'true';
    btn.dataset.active = !isActive;
    btn.style.opacity = !isActive ? '1' : '0.7';

    const resetBtn = document.getElementById('btnReorderReset');
    if (resetBtn) resetBtn.style.display = (!isActive ? '' : '');

    if (!isActive) {
        showAlert('🧲 Modo reordenar ACTIVADO: arrastra y suelta una promoción', 'success');
    } else {
        showAlert('↩️ Modo reordenar DESACTIVADO', 'warning');
    }
}

function resetReorderMode() {
    if (userRole !== 'admin') return;
    const btn = document.getElementById('btnReorderMode');
    if (btn) {
        btn.dataset.active = 'false';
        btn.style.opacity = '0.7';
    }
    renderPromotions();
}

function setPromotionsViewMode(mode) {
    if (mode !== 'blocks' && mode !== 'vertical') return;
    localStorage.setItem('promotionsViewMode', mode);
    applyPromotionsViewMode();
}

function applyPromotionsViewMode() {
    const mode = localStorage.getItem('promotionsViewMode') || 'blocks';
    const container = document.getElementById('promotionsContainer');
    if (!container) return;

    if (mode === 'vertical') {
        container.classList.add('vertical-mode');
        container.classList.remove('blocks-mode');
    } else {
        container.classList.add('blocks-mode');
        container.classList.remove('vertical-mode');
    }
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
            <textarea id="calendarNoteTextarea" data-date="${escapeHtml(dateStr)}" placeholder="Escribe tu nota...">${escapeHtml(note)}</textarea>
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
            <small>${escapeHtml(c.action)}</small><br>
            <small style="opacity:0.7;">Por: ${escapeHtml(c.user)} | ${new Date(c.date).toLocaleString('es-ES')}</small>
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
            <small>${escapeHtml(c.action)}</small><br>
            <small style="opacity:0.7;">Por: ${escapeHtml(c.user)} | ${new Date(c.date).toLocaleString('es-ES')}</small>`;
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
            <small>${escapeHtml(c.action)}</small><br><small style="opacity:0.7;">Por: ${escapeHtml(c.user)}</small>`;
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

// ===== 19b. EXCEL EXPORT SEMANAL COMPLETO =====
async function exportWeeklyExcel(showAlert_msg = true) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = userName; workbook.created = now;

    // Hoja Resumen
    const wsR = workbook.addWorksheet('Resumen');
    wsR.columns = [{width:5},{width:30},{width:30},{width:20}];
    wsR.mergeCells('B2:E2');
    const titleCell = wsR.getCell('B2');
    titleCell.value = '📺 CONTROL SEMANAL COMPLETO - UNITEL';
    titleCell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3C72'}};
    titleCell.font = {bold:true,size:16,color:{argb:'FFFFFFFF'},name:'Calibri'};
    titleCell.alignment = {horizontal:'center',vertical:'middle'};
    wsR.getRow(2).height = 35;

    [['GENERADO POR:', userName],['FECHA:', dateStr],['SEMANA:', `${daysOfWeek.map((d,i) => dayShort[i]).join('-')}`]].forEach(([l,v],i) => {
        wsR.getCell(`B${5+i}`).value = l; wsR.getCell(`B${5+i}`).font = {bold:true};
        wsR.getCell(`C${5+i}`).value = v;
    });

    // Crear tabla resumen por día
    wsR.getCell('B12').value = 'RESUMEN POR DÍA'; wsR.getCell('B12').font = {bold:true,size:12};
    const summaryHeaderRow = wsR.addRow(['DÍA','TOTAL','✅ OK','❌ ERROR','⏳ PENDIENTES','% REVISADO']);
    summaryHeaderRow.number = 13;
    summaryHeaderRow.eachCell(cell => {
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF2A5298'}};
        cell.font = {bold:true,color:{argb:'FFFFFFFF'}};
        cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
        cell.alignment = {horizontal:'center',vertical:'middle'};
    });
    summaryHeaderRow.height = 18;

    let totalAllPromos = 0, totalAllOk = 0, totalAllError = 0, totalAllPending = 0;

    daysOfWeek.forEach((day, idx) => {
        const promos = weekData[day]?.promotions || [];
        const okN = promos.filter(p=>p.status==='ok').length;
        const errN = promos.filter(p=>p.status==='error').length;
        const pendN = promos.filter(p=>p.status==='pending').length;
        const pct = promos.length > 0 ? Math.round(((okN+errN)/promos.length)*100) : 0;

        totalAllPromos += promos.length;
        totalAllOk += okN;
        totalAllError += errN;
        totalAllPending += pendN;

        const summaryRow = wsR.addRow([dayNames[idx], promos.length, okN, errN, pendN, `${pct}%`]);
        summaryRow.eachCell((cell, col) => {
            cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
            if (col === 2) cell.alignment = {horizontal:'center'};
            else if (col > 2) cell.alignment = {horizontal:'center',bold:true};
        });
    });

    const totalRow = wsR.addRow(['TOTAL SEMANA', totalAllPromos, totalAllOk, totalAllError, totalAllPending, totalAllPromos > 0 ? `${Math.round(((totalAllOk+totalAllError)/totalAllPromos)*100)}%` : '0%']);
    totalRow.eachCell(cell => {
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFCCCCCC'}};
        cell.font = {bold:true};
        cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
        cell.alignment = {horizontal:'center'};
    });

    // Crear una hoja para cada día
    daysOfWeek.forEach((day, idx) => {
        const dayName = dayNames[idx];
        const promos = weekData[day]?.promotions || [];
        
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
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    const a = document.createElement('a'); a.href=url; a.download=`Control_Semanal_${dateStr.replace(/\//g,'-')}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);

    if (showAlert_msg) {
        showAlert('✅ Excel semanal exportado', 'success');
    }
    await trackChange('new', 'Exportación Excel semanal realizada');
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

    const recipients = 'amilkar.montano@unitel.com.bo;mathias.molina@unitel.com.bo;csoria@unitel.com.bo';

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
        `Observaciones:\n\n` +
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
let nextWeekImportData = {};  // datos de la próxima semana para importar automáticamente
let lastCheckedDay = null;    // para detectar cambios de semana
let weekRotationInterval = null;  // intervalo para revisar cambios de semana

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
    document.getElementById('weeklyImportDestination').value = 'current';

    const zone = document.getElementById('weeklyImportDropZone');
    zone.ondragover = e => { e.preventDefault(); zone.classList.add('drag-over'); };
    zone.ondragleave = () => zone.classList.remove('drag-over');
    zone.ondrop = e => {
        e.preventDefault(); zone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) processWeeklyFile(e.dataTransfer.files[0]);
    };

    document.getElementById('weeklyImportModal').classList.add('active');
}

function openImportWeeklyModalForNextWeek() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden guardar', 'error');
        return;
    }
    weeklyImportData = {};
    document.getElementById('weeklyImportStep1').style.display = 'block';
    document.getElementById('weeklyImportStep2').style.display = 'none';
    document.getElementById('weeklyImportConfirmBtn').style.display = 'none';
    document.getElementById('weeklyImportFileInput').value = '';
    document.getElementById('weeklyImportDestination').value = 'next';
    updateWeeklyImportMode();

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
    
    // Actualizar la visibilidad según el destino seleccionado
    updateWeeklyImportMode();

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

// ===== IMPORTAR PRÓXIMA SEMANA - ROTACIÓN AUTOMÁTICA =====
function executeWeeklyImportAction() {
    const destination = document.getElementById('weeklyImportDestination').value;
    
    if (destination === 'next') {
        // Guardar los datos en nextWeekImportData
        const totalPromos = Object.values(weeklyImportData).reduce((sum, arr) => sum + arr.length, 0);
        nextWeekImportData = { ...weeklyImportData };
        
        showAlert(`✅ Programación de próxima semana cargada (${totalPromos} promociones). Ahora puedes guardarla en la BD.`, 'success');
        closeModal('weeklyImportModal');
        
        // Abrir el modal para guardar
        openSaveNextWeekModal();
    } else {
        // Importar a semana actual
        executeWeeklyImport();
    }
}

function openSaveNextWeekModal() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores pueden guardar archivos', 'error');
        return;
    }

    // Calcular rango de próxima semana
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilMonday = (1 - dayOfWeek + 7) % 7 || 7;
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + daysUntilMonday);
    
    const nextSunday = new Date(nextMonday);
    nextSunday.setDate(nextMonday.getDate() + 6);
    
    const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const d1 = nextMonday.getDate();
    const d2 = nextSunday.getDate();
    const month1 = monthNames[nextMonday.getMonth()];
    const month2 = monthNames[nextSunday.getMonth()];
    const year = nextSunday.getFullYear();
    
    const labelText = nextMonday.getMonth() === nextSunday.getMonth() 
        ? `${d1} - ${d2} ${month2} ${year}`
        : `${d1} ${month1} - ${d2} ${month2} ${year}`;
    
    document.getElementById('nextWeekLabel').value = labelText;

    // Cargar preview de datos a guardar
    loadNextWeekPreview();

    document.getElementById('saveNextWeekModal').classList.add('active');
}

function loadNextWeekPreview() {
    // Si tiene datos en nextWeekImportData, mostrarlos
    let preview = '';
    if (Object.keys(nextWeekImportData).length > 0) {
        preview = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">';
        daysOfWeek.forEach(day => {
            const count = (nextWeekImportData[day] || []).length;
            const dayName = dayNames[daysOfWeek.indexOf(day)];
            const icon = count > 0 ? '✅' : '⏳';
            preview += `<div style="padding:8px;background:${count > 0 ? '#e8f5e9' : '#fff3e0'};border-radius:6px;border-left:4px solid ${count > 0 ? '#4caf50' : '#ff9800'};"><strong>${dayName}:</strong> ${count} promociones ${icon}</div>`;
        });
        preview += '</div>';
    } else {
        preview = '<p style="color:#e74c3c;font-weight:600;">⚠️ No hay datos de próxima semana cargados. Primero importa el XLSM de próxima semana.</p>';
    }
    document.getElementById('nextWeekSavePreview').innerHTML = preview;
}

async function executeNextWeekSaveXlsm() {
    if (Object.keys(nextWeekImportData).length === 0) {
        showAlert('❌ No hay datos de próxima semana para guardar', 'error');
        return;
    }

    try {
        const buffer = await exportNextWeekToXlsm();
        await saveXlsmToDatabase(buffer);
        
        const labelText = document.getElementById('nextWeekLabel').value;
        const timestamp = new Date().toISOString();
        const filename = `Programacion_ProximaSemana_${labelText.replace(/\s/g,'_')}_${timestamp.split('T')[0]}.xlsm`;
        
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showAlert('✅ Archivo guardado en Supabase y descargado automáticamente', 'success');
        closeModal('saveNextWeekModal');
        
    } catch(error) {
        showAlert('❌ Error: ' + error.message, 'error');
        console.error('Error en executeNextWeekSaveXlsm:', error);
    }
}

async function exportNextWeekToXlsm() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = userName;
    workbook.created = now;

    // Hoja Resumen
    const wsR = workbook.addWorksheet('Resumen');
    wsR.columns = [{width:5},{width:30},{width:30},{width:20}];
    wsR.mergeCells('B2:E2');
    const titleCell = wsR.getCell('B2');
    titleCell.value = '📺 PROGRAMACIÓN PRÓXIMA SEMANA - UNITEL';
    titleCell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3C72'}};
    titleCell.font = {bold:true,size:16,color:{argb:'FFFFFFFF'},name:'Calibri'};
    titleCell.alignment = {horizontal:'center',vertical:'middle'};
    wsR.getRow(2).height = 35;

    const labelText = document.getElementById('nextWeekLabel').value;
    [['ADMINISTRADOR:', userName],['SEMANA:', labelText],['FECHA CREACIÓN:', dateStr]].forEach(([l,v],i) => {
        wsR.getCell(`B${5+i}`).value = l; wsR.getCell(`B${5+i}`).font = {bold:true};
        wsR.getCell(`C${5+i}`).value = v;
    });

    // Tabla resumen por día
    wsR.getCell('B10').value = 'RESUMEN POR DÍA'; wsR.getCell('B10').font = {bold:true,size:12};
    const summaryHeaderRow = wsR.addRow(['DÍA','TOTAL PROMOCIONES']);
    summaryHeaderRow.number = 11;
    summaryHeaderRow.eachCell(cell => {
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF2A5298'}};
        cell.font = {bold:true,color:{argb:'FFFFFFFF'}};
        cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
        cell.alignment = {horizontal:'center',vertical:'middle'};
    });
    summaryHeaderRow.height = 18;

    let totalPromos = 0;
    daysOfWeek.forEach((day, idx) => {
        const count = (nextWeekImportData[day] || []).length;
        totalPromos += count;
        const summaryRow = wsR.addRow([dayNames[idx], count]);
        summaryRow.eachCell(cell => {
            cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
            cell.alignment = {horizontal:'center'};
        });
    });

    const totalRow = wsR.addRow(['TOTAL SEMANA', totalPromos]);
    totalRow.eachCell(cell => {
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFCCCCCC'}};
        cell.font = {bold:true};
        cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
        cell.alignment = {horizontal:'center'};
    });

    // Crear una hoja para cada día con datos
    daysOfWeek.forEach((day, idx) => {
        const dayName = dayNames[idx];
        const promos = nextWeekImportData[day] || [];
        
        if (promos.length === 0) return;
        
        const wsD = workbook.addWorksheet(dayName);
        wsD.columns = [{width:16},{width:45},{width:18},{width:35}];
        wsD.mergeCells('A1:D1');
        const h = wsD.getCell('A1');
        h.value = `PROMOCIONES ${dayName.toUpperCase()}`;
        h.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3C72'}};
        h.font = {bold:true,size:14,color:{argb:'FFFFFFFF'},name:'Calibri'};
        h.alignment = {horizontal:'center',vertical:'middle'};
        wsD.getRow(1).height = 30;

        const headerRow = wsD.addRow(['CÓDIGO','PROGRAMA/NOMBRE','NIVEL','COMENTARIOS']);
        headerRow.eachCell(cell => {
            cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF2A5298'}};
            cell.font = {bold:true,color:{argb:'FFFFFFFF'}};
            cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
            cell.alignment = {horizontal:'center',vertical:'middle',wrapText:true};
        });
        headerRow.height = 22;

        promos.forEach(p => {
            const row = wsD.addRow([p.cod||'', p.desc||'', p.level||'', '']);
            row.eachCell(cell => {
                cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
                cell.alignment = {vertical:'middle',wrapText:true};
            });
        });
    });

    // Generar buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
}

async function saveXlsmToDatabase(buffer) {
    const labelText = document.getElementById('nextWeekLabel').value;
    const timestamp = new Date().toISOString();
    const safeTimestamp = timestamp.replace(/[:.]/g, '-');

    // Evitar colisiones en Supabase Storage:
    // antes se usaba solo YYYY-MM-DD, si se guardaba más de una vez en el mismo día
    // el storagePath quedaba igual y Supabase devolvía "resource already exists".
    const filename = `Programacion_ProximaSemana_${labelText.replace(/\s/g,'_')}_${safeTimestamp}.xlsm`;
    const storagePath = `xlsm_files/${timestamp.split('T')[0]}/${filename}`;
    
    try {
        const { error: uploadError } = await db.storage
            .from('excel-files')
            .upload(storagePath, new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), {
                cacheControl: '3600',
                upsert: false
            });

        if (uploadError) {
            throw new Error('Error subiendo a Storage: ' + uploadError.message);
        }

        const { data: dbData, error: dbError } = await db.from('xlsm_files').insert({
            filename: filename,
            week_label: labelText,
            storage_path: storagePath,
            created_by: userName,
            created_at: timestamp,
            file_size: buffer.byteLength,
            file_type: 'proxima_semana'
        });

        if (dbError) {
            throw new Error('Error guardando metadatos: ' + dbError.message);
        }

        return dbData;

    } catch(error) {
        throw error;
    }
}

async function viewSavedXlsms() {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores', 'error');
        return;
    }

    document.getElementById('viewSavedXlsmModal').classList.add('active');
    loadSavedXlsms();
}

async function loadSavedXlsms() {
    try {
        const { data, error } = await db
            .from('xlsm_files')
            .select('id, filename, week_label, created_by, created_at, file_size')
            .eq('file_type', 'proxima_semana')
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!data || data.length === 0) {
            document.getElementById('savedXlsmsList').innerHTML = '<p style="text-align:center;color:#7f8c8d;">No hay archivos guardados</p>';
            return;
        }

        let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
        html += '<thead><tr style="background:#f9fafb;border-bottom:2px solid #e0e6ed;"><th style="padding:12px;text-align:left;font-weight:600;">📅 Semana</th><th style="padding:12px;text-align:left;font-weight:600;">👤 Por</th><th style="padding:12px;text-align:center;font-weight:600;">📦 Tamaño</th><th style="padding:12px;text-align:center;font-weight:600;">⚙️ Acciones</th></tr></thead>';
        html += '<tbody>';

        data.forEach(file => {
            const date = new Date(file.created_at).toLocaleDateString('es-ES');
            const sizeMB = (file.file_size / 1024 / 1024).toFixed(2);
            html += `<tr style="border-bottom:1px solid #e0e6ed;">
                <td style="padding:12px;">
                    <div style="font-weight:600;">${file.week_label}</div>
                    <div style="font-size:11px;color:#7f8c8d;">${date}</div>
                </td>
                <td style="padding:12px;">${file.created_by}</td>
                <td style="padding:12px;text-align:center;">${sizeMB} MB</td>
                <td style="padding:12px;text-align:center;">
                    <button onclick="downloadXlsm('${file.id}', '${file.filename}')" style="padding:6px 12px;background:linear-gradient(135deg,#27ae60 0%,#1e8449 100%);color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">
                        ⬇️ Descargar
                    </button>
                    <button onclick="deleteSavedXlsm('${file.id}', '${file.filename}')" style="padding:6px 12px;margin-left:8px;background:linear-gradient(135deg,#e74c3c 0%,#c0392b 100%);color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">
                        🗑️ Eliminar
                    </button>
                </td>

            </tr>`;
        });

        html += '</tbody></table>';
        document.getElementById('savedXlsmsList').innerHTML = html;

    } catch(error) {
        console.error('Error cargando archivos:', error);
        document.getElementById('savedXlsmsList').innerHTML = '<p style="color:#e74c3c;">❌ Error cargando archivos</p>';
    }
}

async function downloadXlsm(fileId, filename) {
    try {
        const { data: fileData, error: fileError } = await db
            .from('xlsm_files')
            .select('storage_path')
            .eq('id', fileId)
            .single();

        if (fileError) throw fileError;

        const { data: blob, error: downloadError } = await db.storage
            .from('excel-files')
            .download(fileData.storage_path);

        if (downloadError) throw downloadError;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showAlert('✅ Archivo descargado', 'success');

    } catch(error) {
        showAlert('❌ Error descargando archivo: ' + error.message, 'error');
        console.error('Error:', error);
    }
}

async function deleteSavedXlsm(fileId, filename) {
    if (userRole !== 'admin') {
        showAlert('⛔ Solo administradores', 'error');
        return;
    }

    if (!confirm(`¿Eliminar el archivo guardado?\n\n${filename}`)) return;

    try {
        // 1) Obtener storage_path para borrar el binario
        const { data: fileData, error: fileError } = await db
            .from('xlsm_files')
            .select('storage_path')
            .eq('id', fileId)
            .single();

        if (fileError) throw fileError;

        // Algunas veces el campo puede llamarse distinto (p.ej. storagePath) o venir nulo.
        // Para robustez, tratamos varios nombres.
        const storagePath = fileData?.storage_path || fileData?.storagePath || fileData?.path || null;
        if (!storagePath) {
            throw new Error('storage_path no encontrado (verifica columna en xlsm_files)');
        }


        // 2) Borrar de Supabase Storage
        const { error: storageError } = await db.storage
            .from('excel-files')
            .remove([fileData.storage_path]);

        if (storageError) {
            throw new Error('Error eliminando archivo en Storage: ' + storageError.message);
        }

        // 3) Borrar metadatos
        const { error: dbError } = await db
            .from('xlsm_files')
            .delete()
            .eq('id', fileId);

        if (dbError) {
            throw new Error('Error eliminando metadatos en BD: ' + dbError.message);
        }

        showAlert('🗑️ Archivo eliminado', 'success');

        // Recargar lista
        await loadSavedXlsms();
    } catch(error) {
        showAlert('❌ Error eliminando: ' + error.message, 'error');
        console.error('Error eliminando:', error);
    }
}


function updateWeeklyImportMode() {
    const destination = document.getElementById('weeklyImportDestination').value;
    const conflictGroup = document.getElementById('conflictModeGroup');
    const nextWeekBox = document.getElementById('nextWeekInfoBox');
    const currentWeekBox = document.getElementById('currentWeekInfoBox');
    const header = document.querySelector('#weeklyImportModal .modal-header');
    
    if (destination === 'next') {
        // Ocultar opciones de conflicto (no aplican para próxima semana)
        conflictGroup.style.display = 'none';
        nextWeekBox.style.display = 'block';
        currentWeekBox.style.display = 'none';
        if (header) header.textContent = '📋 Importar Programación Semanal - PRÓXIMA SEMANA (XLSM)';
    } else {
        // Mostrar opciones de conflicto (aplican para semana actual)
        conflictGroup.style.display = 'block';
        nextWeekBox.style.display = 'none';
        currentWeekBox.style.display = 'block';
        if (header) header.textContent = '📋 Importar Programación Semanal (XLSM)';
    }
}


function initWeeklyAutoRotation() {
    // Inicializar el sistema de detección de cambio de semana
    if (weekRotationInterval) clearInterval(weekRotationInterval);
    
    // Revisar cada minuto si cambió el día
    weekRotationInterval = setInterval(checkAndRotateWeek, 60000);
    
    // También hacer una verificación inicial
    checkAndRotateWeek();
}

function checkAndRotateWeek() {
    // Obtener el día de la semana actual
    const today = getCurrentDayOfWeek();
    
    // Si es lunes y el último día revisado fue domingo (cambio de semana)
    if (today === 'monday' && lastCheckedDay === 'sunday' && Object.keys(nextWeekImportData).length > 0) {
        performWeekRotation();
    }
    
    lastCheckedDay = today;
}

async function performWeekRotation() {
    try {
        console.log('🔄 Realizando rotación automática de semana...');
        
        // Paso 1: Eliminar todas las promociones de la semana actual (que era la anterior)
        console.log('📝 Eliminando promociones de la semana anterior...');
        const { error: deleteError } = await db.from('promotions').delete().in('day', daysOfWeek);
        if (deleteError) throw deleteError;
        
        // Limpiar weekData
        daysOfWeek.forEach(d => { weekData[d] = { promotions: [] }; });
        
        // Paso 2: Importar automáticamente las promociones de la próxima semana
        console.log('📝 Importando promociones de la próxima semana...');
        
        let totalInserted = 0;
        for (const [day, promos] of Object.entries(nextWeekImportData)) {
            if (!promos.length) continue;
            
            const toInsert = [];
            promos.forEach(p => {
                const id = 'promo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                toInsert.push({
                    id, day, code: p.cod, name: p.desc, category: p.category,
                    level: p.level, comments: '', status: 'pending',
                    imported_from_xls: true, created_by: 'SISTEMA (Auto-rotación)',
                    created_at: new Date().toISOString(), last_modified: new Date().toISOString()
                });
            });
            
            if (toInsert.length > 0) {
                const { error: insertError } = await db.from('promotions').insert(toInsert);
                if (insertError) throw insertError;
                
                if (!weekData[day]) weekData[day] = { promotions: [] };
                toInsert.forEach(r => weekData[day].promotions.push(mapDbToPromo(r)));
                totalInserted += toInsert.length;
            }
        }
        
        // Limpiar nextWeekImportData después de importar
        nextWeekImportData = {};
        
        // Registrar el cambio
        await trackChange('new', `Rotación automática de semana: ${totalInserted} promociones importadas`);
        
        // Actualizar UI
        generateDayTabs();
        renderPromotions();
        updateStatistics();

        // Exportar automáticamente un Excel con los nuevos datos
        await exportWeeklyExcel(false);

        showAlert(`✅ Rotación de semana completada automáticamente. ${totalInserted} promociones de la próxima semana importadas. Excel actualizado descargado.`, 'success');
        console.log('✅ Rotación completada exitosamente');
        
    } catch(e) {
        console.error('❌ Error en rotación automática:', e);
        showAlert('❌ Error en rotación automática: ' + e.message, 'error');
    }
}

function getCurrentDayOfWeek() {
    const map = { 0: 'sunday', 1: 'monday', 2: 'tuesday', 3: 'wednesday', 
                  4: 'thursday', 5: 'friday', 6: 'saturday' };
    return map[new Date().getDay()] || 'sunday';
}