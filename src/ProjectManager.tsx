import { useEffect, useRef, useState } from 'react';
import { Copy, Download, FolderOpen, Plus, X } from 'lucide-react';
import { ProjectSummary } from './core/projectLibrary';

interface Props {
  open: boolean;
  busy: boolean;
  currentId: string;
  name: string;
  projects: ProjectSummary[];
  status: string;
  onClose: () => void;
  onRename: (name: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onOpen: (id: string) => void;
  onDownload: () => void;
  onImport: (file: File) => void;
}

export function ProjectManager(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(props.name);
  useEffect(() => { setName(props.name); }, [props.name, props.open]);
  useEffect(() => {
    if (props.open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [props.open]);
  return <dialog ref={dialog} className="project-dialog" onCancel={(event) => {
    if (props.busy) event.preventDefault(); else props.onClose();
  }}>
    <div className="project-dialog-heading"><div><span className="eyebrow">CUEFORGE</span><h2>Projects</h2></div>
      <button className="btn" aria-label="Close projects" disabled={props.busy} onClick={props.onClose}><X size={16} /></button></div>
    <p className="project-note">Saved automatically in this browser, including audio and stems. Download a project to back it up or move it to another computer.</p>
    <fieldset disabled={props.busy} className="project-controls">
      <form className="project-rename" onSubmit={(event) => { event.preventDefault(); if (name.trim()) props.onRename(name.trim()); }}>
        <label className="field-label">Current project<input type="text" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></label>
        <button className="btn" type="submit" disabled={!name.trim() || name.trim() === props.name}>Rename</button>
      </form>
      <div className="project-toolbar">
        <button className="btn btn-primary" onClick={props.onNew}><Plus size={14} />New project</button>
        <button className="btn" onClick={props.onDuplicate}><Copy size={14} />Duplicate</button>
        <button className="btn" onClick={props.onDownload}><Download size={14} />Download project</button>
        <label className="btn project-file"><FolderOpen size={14} />Open file<input type="file" accept=".cueforge,.json" onChange={(event) => {
          const file = event.target.files?.[0]; if (file) props.onImport(file); event.target.value = '';
        }} /></label>
      </div>
      <div className="project-list" aria-label="Saved projects">
        {props.projects.length === 0 && <p className="project-note">Your first project will appear here after saving.</p>}
        {props.projects.map((project) => <button className="project-row" key={project.id} disabled={project.id === props.currentId} onClick={() => props.onOpen(project.id)}>
          <FolderOpen size={19} /><span><strong>{project.name}</strong><small>{project.markerCount} markers · {project.stemCount} stems · {new Date(project.updatedAt).toLocaleString()}</small></span>
          <span className="project-row-state">{project.id === props.currentId ? 'Current' : 'Open'}</span>
        </button>)}
      </div>
    </fieldset>
    <p className="project-save-status" role="status">{props.status}</p>
  </dialog>;
}
