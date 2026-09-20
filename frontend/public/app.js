(() => {
  'use strict';

  const PROJECT_STATUSES = ['active', 'archived'];
  const TASK_STATUSES = ['todo', 'in_progress', 'done'];
  const STATUS_LABELS = { todo: 'Todo', in_progress: 'In progress', done: 'Done' };

  const $ = (id) => document.getElementById(id);
  const listEl = $('project-list');
  const viewEl = $('project-view');
  const searchEl = $('project-search');

  function makeEl(tag, attrs = {}, text = '') {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'data') node.dataset[value] = '';
      else if (typeof value === 'function' && key.startsWith('on')) {
        node.addEventListener(key.slice(2), value);
      } else node.setAttribute(key, value);
    }
    if (text) node.textContent = text;
    return node;
  }

  function makeSelect(options, selected, onChange) {
    const select = makeEl('select', { onchange: onChange });
    for (const [value, label] of Object.entries(options)) {
      const option = makeEl('option', { value }, label);
      if (value === selected) option.selected = true;
      select.appendChild(option);
    }
    return select;
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function currentHashProject() {
    const match = /^#\/project\/(\d+)$/.exec(window.location.hash);
    return match ? Number(match[1]) : null;
  }

  function setDeepLink(projectId) {
    const next = projectId == null ? '#/' : `#/project/${projectId}`;
    if (window.location.hash !== next) window.history.pushState(null, '', next);
  }

  let projects = [];
  let projectSearchTimer = null;
  let taskSearchTimer = null;

  async function loadProjects() {
    const search = searchEl.value.trim();
    projects = await api(`/projects${search ? `?search=${encodeURIComponent(search)}` : ''}`);
    renderProjectList();
    const selected = currentHashProject();
    if (selected != null && projects.some((p) => p.id === selected)) {
      selectProject(selected, false);
    } else if (projects.length > 0) {
      selectProject(projects[0].id, false);
    } else {
      setDeepLink(null);
      renderNoProject();
    }
  }

  function renderProjectList() {
    listEl.replaceChildren();
    for (const project of projects) {
      const item = makeEl('li', { class: 'project-item' });
      const main = makeEl(
        'button',
        {
          class: 'project-btn',
          type: 'button',
          onclick: () => selectProject(project.id, true),
        },
        project.name,
      );
      const badge = makeEl('span', { class: `badge badge-${project.status}` }, project.status);
      const editBtn = makeEl(
        'button',
        { class: 'mini-btn', type: 'button', title: 'Rename / status' },
        '✎',
      );
      editBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        beginProjectEdit(item, project);
      });
      const deleteBtn = makeEl(
        'button',
        { class: 'mini-btn danger', type: 'button', title: 'Delete project' },
        '🗑',
      );
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteProject(project);
      });
      const row = makeEl('div', { class: 'project-meta' });
      row.append(badge, editBtn, deleteBtn);
      item.append(main, row);
      listEl.appendChild(item);
    }
  }

  function beginProjectEdit(item, project) {
    item.replaceChildren();
    const form = makeEl('form', {
      class: 'project-edit',
      onsubmit: async (event) => {
        event.preventDefault();
        const name = form.nameField.value.trim();
        if (!name) return;
        const updated = await api(`/projects/${project.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, status: form.statusSelect.value }),
        });
        await loadProjects();
        if (currentHashProject() === project.id) renderProjectView(updated);
      },
    });
    const nameField = makeEl('input', {
      name: 'nameField',
      type: 'text',
      maxlength: 120,
      required: true,
      value: project.name,
    });
    const statusSelect = makeSelect(
      Object.fromEntries(PROJECT_STATUSES.map((s) => [s, s])),
      project.status,
    );
    statusSelect.name = 'statusSelect';
    const save = makeEl('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');
    const cancel = makeEl(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          listEl.replaceChildren();
          renderProjectList();
        },
      },
      'Cancel',
    );
    form.append(nameField, statusSelect, save, cancel);
    item.appendChild(form);
    nameField.focus();
  }

  async function deleteProject(project) {
    const message = `Delete project "${project.name}" and all its tasks?`;
    if (!window.confirm(message)) return;
    await api(`/projects/${project.id}`, { method: 'DELETE' });
    if (currentHashProject() === project.id) setDeepLink(null);
    await loadProjects();
  }

  function renderNoProject() {
    viewEl.replaceChildren(makeEl('p', { class: 'empty' }, 'Select a project on the left to view its tasks.'));
  }

  async function selectProject(projectId, updateLink) {
    if (updateLink) setDeepLink(projectId);
    const project = await api(`/projects/${projectId}`);
    await renderProjectView(project);
  }

  async function renderProjectView(project) {
    const statusFilter = $('task-status-filter')?.value || 'all';
    const search = $('task-search')?.value.trim() || '';
    const taskParams = new URLSearchParams();
    if (project.id) taskParams.set('project_id', String(project.id));
    if (statusFilter !== 'all') taskParams.set('status', statusFilter);
    if (search) taskParams.set('q', search);
    const tasks = await api(`/tasks?${taskParams.toString()}`);

    const header = makeEl('section', { class: 'project-head' });
    header.append(makeEl('h2', { class: 'project-title' }, project.name));
    header.append(
      makeEl('span', { class: `badge badge-${project.status}` }, project.status),
    );

    const addForm = makeEl('form', {
      class: 'task-add',
      onsubmit: async (event) => {
        event.preventDefault();
        const title = addForm.titleField.value.trim();
        if (!title) return;
        await api('/tasks', {
          method: 'POST',
          body: JSON.stringify({
            project_id: project.id,
            title,
            status: addForm.statusField.value,
          }),
        });
        await renderProjectView(project);
      },
    });
    const titleField = makeEl('input', {
      name: 'titleField',
      type: 'text',
      placeholder: 'New task…',
      maxlength: 200,
      required: true,
    });
    const statusField = makeSelect(TASK_STATUSES.reduce((acc, s) => ((acc[s] = STATUS_LABELS[s]), acc), {}), 'todo');
    statusField.name = 'statusField';
    addForm.append(
      titleField,
      statusField,
      makeEl('button', { class: 'btn btn-primary', type: 'submit' }, 'Add task'),
    );

    const filters = makeEl('div', { class: 'filters' });
    const statusSelect = makeSelect(
      { all: 'All statuses', ...TASK_STATUSES.reduce((acc, s) => ((acc[s] = STATUS_LABELS[s]), acc), {}) },
      statusFilter,
      () => renderProjectView(project),
    );
    statusSelect.id = 'task-status-filter';
    const taskSearch = makeEl('input', {
      id: 'task-search',
      type: 'search',
      placeholder: 'Search tasks…',
      value: search,
    });
    const delay = 300;
    taskSearch.addEventListener('input', () => {
      window.clearTimeout(taskSearchTimer);
      taskSearchTimer = window.setTimeout(() => renderProjectView(project), delay);
    });
    filters.append(statusSelect, taskSearch);

    const taskList = makeEl('ul', { class: 'task-list' });
    if (tasks.length === 0) {
      taskList.appendChild(makeEl('li', { class: 'empty' }, 'No tasks match this filter.'));
    }
    for (const task of tasks) {
      taskList.appendChild(renderTaskRow(task, project));
    }

    const addSection = makeEl('section');
    addSection.append(addForm);
    const listSection = makeEl('section', { class: 'task-section' });
    listSection.append(filters, taskList);

    viewEl.replaceChildren(header, addSection, listSection);
  }

  function renderTaskRow(task, project) {
    const row = makeEl('li', { class: 'task-row' });
    const title = makeEl('span', { class: `task-title task-${task.status}` }, task.title);
    const editEl = makeEl('span', { class: 'task-title task-edit', hidden: true });

    const statusSelect = makeSelect(
      TASK_STATUSES.reduce((acc, s) => ((acc[s] = STATUS_LABELS[s]), acc), {}),
      task.status,
      async (event) => {
        await api(`/tasks/${task.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: event.target.value }),
        });
        await renderProjectView(project);
      },
    );

    const doneBtn = makeEl(
      'button',
      { class: 'mini-btn', type: 'button', title: 'Edit title' },
      '✎',
    );
    const deleteBtn = makeEl(
      'button',
      { class: 'mini-btn danger', type: 'button', title: 'Delete task' },
      '🗑',
    );
    deleteBtn.addEventListener('click', async () => {
      if (window.confirm(`Delete task "${task.title}"?`)) {
        await api(`/tasks/${task.id}`, { method: 'DELETE' });
        await renderProjectView(project);
      }
    });

    doneBtn.addEventListener('click', () => {
      title.hidden = !title.hidden;
      editEl.hidden = !editEl.hidden;
    });

    const editForm = makeEl('form', {
      class: 'task-edit',
      onsubmit: async (event) => {
        event.preventDefault();
        const newTitle = editForm.titleField.value.trim();
        if (!newTitle) return;
        await api(`/tasks/${task.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: newTitle }),
        });
        await renderProjectView(project);
      },
    });
    const titleInput = makeEl('input', {
      name: 'titleField',
      type: 'text',
      maxlength: 200,
      value: task.title,
    });
    editForm.append(
      titleInput,
      makeEl('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
    );

    editEl.appendChild(editForm);
    const actions = makeEl('span', { class: 'task-actions' });
    actions.append(statusSelect, doneBtn, deleteBtn);
    row.append(title, editEl, actions);
    return row;
  }

  searchEl.addEventListener('input', () => {
    window.clearTimeout(projectSearchTimer);
    projectSearchTimer = window.setTimeout(loadProjects, 300);
  });

  $('new-project-btn').addEventListener('click', async () => {
    const name = window.prompt('Project name:');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const project = await api('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: trimmed }),
    });
    setDeepLink(project.id);
    await loadProjects();
  });

  window.addEventListener('hashchange', () => {
    const id = currentHashProject();
    if (id != null) selectProject(id, false);
  });

  async function init() {
    const release = $('release').dataset.release || 'local';
    $('release').textContent = `release ${release}`;
    try {
      const meta = await api('/meta');
      $('api-meta').textContent = `api ${meta.release} · node ${meta.node} · ${meta.db}`;
    } catch {
      $('api-meta').textContent = 'api unreachable';
    }
    await loadProjects();
  }

  init();
})();