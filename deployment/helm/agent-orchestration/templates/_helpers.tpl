{{- define "ao.name" -}}{{ .Release.Name }}-agent-orchestration{{- end -}}
{{- define "ao.labels" -}}
app.kubernetes.io/name: agent-orchestration
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
