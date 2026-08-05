package tool

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
)

// SchemaDialect is the JSON Schema dialect the generated files declare.
const SchemaDialect = "https://json-schema.org/draft/2020-12/schema"

// Schema is the subset of JSON Schema the wire types need. Field order here is
// the key order in the generated files, so keep the identifying keys first.
type Schema struct {
	Dialect              string     `json:"$schema,omitempty"`
	Title                string     `json:"title,omitempty"`
	Type                 TypeSet    `json:"type,omitempty"`
	Description          string     `json:"description,omitempty"`
	Properties           Properties `json:"properties,omitempty"`
	Required             []string   `json:"required,omitempty"`
	AdditionalProperties *Schema    `json:"additionalProperties,omitempty"`
	Items                *Schema    `json:"items,omitempty"`
	ContentEncoding      string     `json:"contentEncoding,omitempty"`
}

// TypeSet is a JSON Schema "type", which is a string for the common case and an
// array when a value is nullable. A required Go field of a nilable kind really
// does encode as null — protocol.Response.Stdout is a plain []byte, so a command
// that printed nothing sends `"stdout": null`, not `""`.
type TypeSet []string

// MarshalJSON writes a single type as a bare string and several as an array.
func (t TypeSet) MarshalJSON() ([]byte, error) {
	if len(t) == 1 {
		return json.Marshal(t[0])
	}
	return json.Marshal([]string(t))
}

// Properties preserves declaration order through marshalling. JSON Schema
// treats "properties" as an unordered object, but these files are read by
// people: a map would sort `max_output` between `env` and `stdin` and scatter
// the fields that belong together.
type Properties []Property

// Property is one named entry of a Properties list.
type Property struct {
	Name   string
	Schema *Schema
}

// Get returns the named property's schema, or nil.
func (p Properties) Get(name string) *Schema {
	for _, prop := range p {
		if prop.Name == name {
			return prop.Schema
		}
	}
	return nil
}

// Names returns the property names in declaration order.
func (p Properties) Names() []string {
	names := make([]string, len(p))
	for i, prop := range p {
		names[i] = prop.Name
	}
	return names
}

// MarshalJSON writes the properties as a JSON object in declaration order.
func (p Properties) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, prop := range p {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := json.Marshal(prop.Name)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		val, err := marshalNoEscape(prop.Schema)
		if err != nil {
			return nil, err
		}
		b.Write(val)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// marshalNoEscape is json.Marshal without HTML escaping. It matters here
// because the outer encoder can only avoid *adding* escapes: once a Marshaler
// has turned `&&` into `&&`, nothing downstream puts it back.
func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// omit drops the named properties and any matching required entries, returning
// a shallow copy. Used to hide `op` from the model: the tool picks the op.
func (s *Schema) omit(names ...string) *Schema {
	drop := make(map[string]struct{}, len(names))
	for _, n := range names {
		drop[n] = struct{}{}
	}
	out := *s
	out.Properties = nil
	for _, prop := range s.Properties {
		if _, skip := drop[prop.Name]; !skip {
			out.Properties = append(out.Properties, prop)
		}
	}
	out.Required = nil
	for _, req := range s.Required {
		if _, skip := drop[req]; !skip {
			out.Required = append(out.Required, req)
		}
	}
	return &out
}

// titled returns a shallow copy under a new title.
func (s *Schema) titled(title string) *Schema {
	out := *s
	out.Title = title
	return &out
}

// require returns a shallow copy whose required list is exactly names. The
// wire types mark everything but `op` as omitempty, which is right for the
// protocol and wrong for a model: a tool call with no `cmd` is meaningless.
func (s *Schema) require(names ...string) *Schema {
	out := *s
	out.Required = names
	return &out
}

// objectSchema derives a JSON Schema from a Go struct. Descriptions come from
// docs, keyed by JSON field name; a field with no entry is an error rather
// than an undocumented property, which is what keeps the model-facing surface
// from silently growing when someone adds a field to the wire types.
func objectSchema(t reflect.Type, title string, docs map[string]string) (*Schema, error) {
	if t.Kind() != reflect.Struct {
		return nil, fmt.Errorf("tool: %s is not a struct", t)
	}
	s := &Schema{Dialect: SchemaDialect, Title: title, Type: TypeSet{"object"}}
	for i := range t.NumField() {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		name, omitempty := parseJSONTag(f)
		if name == "-" {
			continue
		}
		desc, ok := docs[name]
		if !ok {
			return nil, fmt.Errorf("tool: %s.%s (json %q) has no description", t.Name(), f.Name, name)
		}
		fs, err := fieldSchema(f.Type)
		if err != nil {
			return nil, fmt.Errorf("tool: %s.%s: %w", t.Name(), f.Name, err)
		}
		fs.Description = desc
		// A nilable field that is not omitempty encodes as null when unset, so
		// the schema has to admit null or it describes a wire we do not emit.
		if !omitempty && isNilable(f.Type) {
			fs.Type = append(fs.Type, "null")
		}
		s.Properties = append(s.Properties, Property{Name: name, Schema: fs})
		if !omitempty {
			s.Required = append(s.Required, name)
		}
	}
	return s, nil
}

// nestedSchemas holds the schemas of struct types that appear as fields of
// other structs. Descriptions are hand-written per type (they are prompt text,
// not Go docs), so a nested struct has to be built and registered explicitly
// rather than reflected over blindly — the same rule that makes an
// undocumented field a hard error applies one level down.
var nestedSchemas = map[reflect.Type]*Schema{}

func fieldSchema(t reflect.Type) (*Schema, error) {
	switch t.Kind() {
	case reflect.Struct:
		s, ok := nestedSchemas[t]
		if !ok {
			return nil, fmt.Errorf("no JSON Schema mapping for %s (register it in nestedSchemas)", t)
		}
		return s.embedded(), nil
	case reflect.String:
		return &Schema{Type: TypeSet{"string"}}, nil
	case reflect.Bool:
		return &Schema{Type: TypeSet{"boolean"}}, nil
	case reflect.Int, reflect.Int32, reflect.Int64:
		return &Schema{Type: TypeSet{"integer"}}, nil
	case reflect.Slice:
		// encoding/json renders []byte as a base64 string, so the schema has to
		// say string — an array of integers would be a lie the model believes.
		if t.Elem().Kind() == reflect.Uint8 {
			return &Schema{Type: TypeSet{"string"}, ContentEncoding: "base64"}, nil
		}
		elem, err := fieldSchema(t.Elem())
		if err != nil {
			return nil, err
		}
		return &Schema{Type: TypeSet{"array"}, Items: elem}, nil
	case reflect.Map:
		if t.Key().Kind() != reflect.String {
			return nil, fmt.Errorf("map key %s is not a string", t.Key())
		}
		elem, err := fieldSchema(t.Elem())
		if err != nil {
			return nil, err
		}
		return &Schema{Type: TypeSet{"object"}, AdditionalProperties: elem}, nil
	default:
		return nil, fmt.Errorf("no JSON Schema mapping for %s", t)
	}
}

// embedded copies a schema for use as a field: the dialect and title belong to
// a document root, not to a property inside one.
func (s *Schema) embedded() *Schema {
	c := *s
	c.Dialect = ""
	c.Title = ""
	return &c
}

// isNilable reports whether a Go value of this type can marshal to JSON null.
func isNilable(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.Slice, reflect.Map, reflect.Pointer, reflect.Interface:
		return true
	default:
		return false
	}
}

func parseJSONTag(f reflect.StructField) (name string, omitempty bool) {
	tag := f.Tag.Get("json")
	if tag == "" {
		return f.Name, false
	}
	parts := strings.Split(tag, ",")
	name = parts[0]
	if name == "" {
		name = f.Name
	}
	for _, opt := range parts[1:] {
		if opt == "omitempty" {
			omitempty = true
		}
	}
	return name, omitempty
}
