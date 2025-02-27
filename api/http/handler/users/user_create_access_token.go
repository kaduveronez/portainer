package users

import (
	"errors"
	"net/http"

	portainer "github.com/portainer/portainer/api"
	httperrors "github.com/portainer/portainer/api/http/errors"
	"github.com/portainer/portainer/api/http/security"
	httperror "github.com/portainer/portainer/pkg/libhttp/error"
	"github.com/portainer/portainer/pkg/libhttp/request"
	"github.com/portainer/portainer/pkg/libhttp/response"

	"github.com/asaskevich/govalidator"
)

type userAccessTokenCreatePayload struct {
	Description string `validate:"required" example:"github-api-key" json:"description"`
}

func (payload *userAccessTokenCreatePayload) Validate(r *http.Request) error {
	if govalidator.IsNull(payload.Description) {
		return errors.New("invalid description. cannot be empty")
	}
	if govalidator.HasWhitespaceOnly(payload.Description) {
		return errors.New("invalid description. cannot contain only whitespaces")
	}
	if govalidator.MinStringLength(payload.Description, "128") {
		return errors.New("invalid description. cannot be longer than 128 characters")
	}
	return nil
}

type accessTokenResponse struct {
	RawAPIKey string           `json:"rawAPIKey"`
	APIKey    portainer.APIKey `json:"apiKey"`
}

// @id UserGenerateAPIKey
// @summary Generate an API key for a user
// @description Generates an API key for a user.
// @description Only the calling user can generate a token for themselves.
// @description **Access policy**: restricted
// @tags users
// @security jwt
// @accept json
// @produce json
// @param id path int true "User identifier"
// @param body body userAccessTokenCreatePayload true "details"
// @success 201 {object} accessTokenResponse "Created"
// @failure 400 "Invalid request"
// @failure 401 "Unauthorized"
// @failure 403 "Permission denied"
// @failure 404 "User not found"
// @failure 500 "Server error"
// @router /users/{id}/tokens [post]
func (handler *Handler) userCreateAccessToken(w http.ResponseWriter, r *http.Request) *httperror.HandlerError {
	// specifically require Cookie auth for this endpoint since API-Key based auth is not supported
	if jwt, _ := handler.bouncer.CookieAuthLookup(r); jwt == nil {
		return httperror.Unauthorized("Auth not supported", errors.New("Cookie Authentication required"))
	}

	var payload userAccessTokenCreatePayload
	err := request.DecodeAndValidateJSONPayload(r, &payload)
	if err != nil {
		return httperror.BadRequest("Invalid request payload", err)
	}

	userID, err := request.RetrieveNumericRouteVariableValue(r, "id")
	if err != nil {
		return httperror.BadRequest("Invalid user identifier route variable", err)
	}

	tokenData, err := security.RetrieveTokenData(r)
	if err != nil {
		return httperror.InternalServerError("Unable to retrieve user authentication token", err)
	}

	if tokenData.ID != portainer.UserID(userID) {
		return httperror.Forbidden("Permission denied to create user access token", httperrors.ErrUnauthorized)
	}

	user, err := handler.DataStore.User().Read(portainer.UserID(userID))
	if err != nil {
		return httperror.BadRequest("Unable to find a user", err)
	}

	rawAPIKey, apiKey, err := handler.apiKeyService.GenerateApiKey(*user, payload.Description)
	if err != nil {
		return httperror.InternalServerError("Internal Server Error", err)
	}

	w.WriteHeader(http.StatusCreated)
	return response.JSON(w, accessTokenResponse{rawAPIKey, *apiKey})
}
