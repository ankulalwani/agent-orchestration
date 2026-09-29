{{- define "ao.name" -}}{{ .Release.Name }}-agent-orchestrator{{- end -}}
{{- define "ao.labels" -}}
app.kubernetes.io/name: agent-orchestrator
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
